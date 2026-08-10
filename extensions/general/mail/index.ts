import { NextResponse } from 'next/server'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { registerMailSearchService } from '@/lib/mail-search/service'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { canWriteCompany } from '@/lib/auth/require-write'
import { GmailSearchService } from './lib/search-service'
import { createOAuthState, verifyOAuthState } from './lib/crypto'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getGoogleOAuthEnv,
  isGoogleMailConfigured,
} from './lib/google-oauth'
import { disconnect, listConnections, saveConnection, updateBackfill } from './lib/connections'
import { resolveCallbackOrigin } from './lib/callback-origin'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

// Registered as soon as the extension loads, so the receipt hunt can search
// mail without core ever importing from @/extensions.
registerMailSearchService(new GmailSearchService())

function jsonError(message: string, status = 500): Response {
  return NextResponse.json({ error: message }, { status })
}

/** How far back a newly connected mailbox may be searched, in days. */
const BACKFILL_CHOICES = new Set([30, 90, 365])

/** Mailbox search is not resumable enough for the production route yet. */
export function isMailHuntConnectionAvailable(): boolean {
  return process.env.NODE_ENV !== 'production'
}

async function canMutateMail(ctx: ExtensionContext): Promise<boolean> {
  return canWriteCompany(ctx.supabase, ctx.userId, ctx.companyId)
}

async function canUseMailAi(
  ctx: ExtensionContext,
  companyId: string = ctx.companyId,
): Promise<boolean> {
  return hasCapability(ctx.supabase, companyId, CAPABILITY.ai)
}

export const mailExtension: Extension = {
  id: 'mail',
  name: 'Brevlådor',
  version: '0.1.0',
  sector: 'general',

  settingsPanel: {
    label: 'Brevlådor',
    path: '/settings/mail',
  },

  apiRoutes: [
    // Start the consent flow. Returns the URL rather than redirecting so the
    // caller can open it in a deliberate, user-gesture tab.
    {
      method: 'POST',
      path: '/oauth/start',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        if (!(await canMutateMail(ctx))) return jsonError('forbidden', 403)
        if (!isMailHuntConnectionAvailable()) return jsonError('preview_disabled', 503)
        if (!(await canUseMailAi(ctx))) return jsonError('entitlement_required', 403)
        if (!isGoogleMailConfigured()) return jsonError('provider_not_configured', 400)
        try {
          const url = new URL(request.url)
          const origin = resolveCallbackOrigin(url.origin)
          const state = createOAuthState(ctx.userId, ctx.companyId)
          const env = getGoogleOAuthEnv(origin)
          return NextResponse.json({ url: buildAuthorizationUrl(env, state) })
        } catch (err) {
          ctx.log.error('mail oauth start failed', err)
          return jsonError(err instanceof Error ? err.message : 'Could not start OAuth', 500)
        }
      },
    },

    // Google redirects here after consent. Registered in the Google console as
    // an authorised redirect URI: the `mail` slug and this path are pinned and
    // must never be renamed without re-registering.
    {
      method: 'GET',
      path: '/oauth/callback',
      handler: async (request, ctx) => {
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const settingsUrl = `${resolveCallbackOrigin(url.origin)}/settings/mail`

        // The user declining is a normal outcome, not an error to shout about.
        if (error) return NextResponse.redirect(`${settingsUrl}?mail=denied`)
        if (!code || !state) return NextResponse.redirect(`${settingsUrl}?mail=invalid`)
        if (!isMailHuntConnectionAvailable()) {
          return NextResponse.redirect(`${settingsUrl}?mail=preview_disabled`)
        }

        const verified = verifyOAuthState(state)
        if (!verified) return NextResponse.redirect(`${settingsUrl}?mail=expired`)

        // Bind the browser session to the exact actor and tenant signed into
        // state. A company switch, removed membership, or viewer downgrade must
        // fail before the one-time authorization code is exchanged.
        if (
          !ctx ||
          ctx.userId !== verified.userId ||
          ctx.companyId !== verified.companyId ||
          !(await canWriteCompany(ctx.supabase, verified.userId, verified.companyId))
        ) {
          return NextResponse.redirect(`${settingsUrl}?mail=forbidden`)
        }

        try {
          const origin = resolveCallbackOrigin(url.origin)
          const env = getGoogleOAuthEnv(origin)
          if (!(await canUseMailAi(ctx, verified.companyId))) {
            return NextResponse.redirect(`${settingsUrl}?mail=entitlement_required`)
          }
          const tokens = await exchangeCodeForTokens(env, code)
          if (!tokens.refreshToken) {
            return NextResponse.redirect(`${settingsUrl}?mail=no_refresh_token`)
          }
          if (!tokens.email) {
            // Without the address we cannot tell two grants apart, and the
            // unique key depends on it.
            return NextResponse.redirect(`${settingsUrl}?mail=no_address`)
          }

          // The exchange is an external round trip. Recheck once more before
          // persisting in case the membership changed while it was in flight.
          if (!(await canWriteCompany(ctx.supabase, verified.userId, verified.companyId))) {
            return NextResponse.redirect(`${settingsUrl}?mail=forbidden`)
          }
          if (!(await canUseMailAi(ctx))) {
            return NextResponse.redirect(`${settingsUrl}?mail=entitlement_required`)
          }

          await saveConnection(createServiceClientNoCookies(), {
            companyId: verified.companyId,
            userId: verified.userId,
            provider: 'gmail',
            emailAddress: tokens.email,
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
            backfillFrom: null,
          })
          return NextResponse.redirect(`${settingsUrl}?mail=connected`)
        } catch {
          return NextResponse.redirect(`${settingsUrl}?mail=failed`)
        }
      },
    },

    // What this company has connected. Safe projection only: never tokens.
    {
      method: 'GET',
      path: '/connections',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const connections = await listConnections(createServiceClientNoCookies(), ctx.companyId)
        return NextResponse.json({
          data: {
            connections,
            configured: isGoogleMailConfigured(),
            connectAvailable: isMailHuntConnectionAvailable(),
          },
        })
      },
    },

    {
      method: 'DELETE',
      path: '/connections',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        if (!(await canMutateMail(ctx))) return jsonError('forbidden', 403)
        const id = new URL(request.url).searchParams.get('id')
        if (!id) return jsonError('missing_id', 400)
        await disconnect(createServiceClientNoCookies(), ctx.companyId, id, ctx.userId)
        return NextResponse.json({ data: { disconnected: true } })
      },
    },

    // How far back a mailbox may be searched once, chosen by the user at
    // connect time. Bounded to the offered choices so an arbitrary date cannot
    // widen the grant's reach by hand.
    {
      method: 'POST',
      path: '/connections/backfill',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        if (!(await canMutateMail(ctx))) return jsonError('forbidden', 403)
        if (!isMailHuntConnectionAvailable()) return jsonError('preview_disabled', 503)
        if (!(await canUseMailAi(ctx))) return jsonError('entitlement_required', 403)
        const body = (await request.json().catch(() => ({}))) as { id?: string; days?: number }
        if (!body.id || !body.days || !BACKFILL_CHOICES.has(body.days)) {
          return jsonError('invalid_request', 400)
        }
        const from = new Date()
        from.setDate(from.getDate() - body.days)
        const backfillFrom = from.toISOString().slice(0, 10)
        await updateBackfill(
          createServiceClientNoCookies(),
          ctx.companyId,
          body.id,
          ctx.userId,
          backfillFrom,
        )
        return NextResponse.json({ data: { backfill_from: backfillFrom } })
      },
    },
  ],
}
