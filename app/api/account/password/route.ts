import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { SupabaseClient } from '@supabase/supabase-js'
import { userHasPassword } from '@/lib/auth/has-password'

const log = createLogger('api/account/password')

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Lösenordet måste vara minst 8 tecken')
    .refine(
      (v) =>
        /[a-z]/.test(v) &&
        /[A-Z]/.test(v) &&
        /[0-9]/.test(v) &&
        /[^a-zA-Z0-9]/.test(v),
      'Lösenordet måste innehålla versaler, gemener, siffror och specialtecken',
    ),
})

function hasRecoveryMethod(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false
  return amr.some((entry) => {
    if (entry === 'recovery') return true
    return (
      entry !== null &&
      typeof entry === 'object' &&
      'method' in entry &&
      entry.method === 'recovery'
    )
  })
}

async function isVerifiedRecoverySession(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getClaims()
    const claims = data?.claims
    return !error && claims?.sub === userId && hasRecoveryMethod(claims.amr)
  } catch {
    return false
  }
}

/**
 * POST /api/account/password
 *
 * Server-routed password set/change, then flips `app_metadata.has_password =
 * true` via the service client (clients can't write app_metadata).
 *
 * Two paths depending on whether the user already has a real password:
 *
 *   - First-time set (`userHasPassword() === false`): write via the
 *     admin API. BankID-only users (and legacy users whose `has_password`
 *     flag was set to false by the backfill) sit at AAL1 with a TOTP factor
 *     enrolled, and `updateUser` on the user session would be rejected with
 *     "AAL2 session is required to update email or password when MFA is
 *     enabled". Setting an initial password has no existing credential to
 *     protect, so bypassing AAL2 is safe.
 *
 *   - Change-password (`app_metadata.has_password === true`): write via the
 *     user session so Supabase's AAL2 guard still fires. A stolen AAL1
 *     cookie must not be able to rotate a known password.
 *
 * This route is the single write path for setting a password. SecuritySettings,
 * the reset-password page, and the /account/set-password page all funnel
 * through here so the flag stays in sync: see lib/auth/has-password.ts.
 *
 * First-password writes set the password and marker in one Auth operation. For
 * existing passwords, a later marker refresh is only normalization for legacy
 * email users: missing metadata is already classified as having a password, so
 * a refresh failure cannot reopen the first-password exception.
 */
export async function POST(request: Request) {
  // This endpoint has two deliberately narrower sinks than the generic AAL2
  // route guard. Establish identity from Auth first, then authorize the sink:
  // first-password admin writes use server-owned metadata, while an existing
  // password requires either a verified recovery JWT or the normal MFA guard.
  const supabase = await createClient()
  const { data: userData, error: identityError } = await supabase.auth.getUser()
  const user = userData?.user ?? null
  if (identityError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await validateBody(request, SetPasswordSchema)
  if (!result.success) return result.response
  const { password } = result.data

  const isFirstTimeSet = !userHasPassword(user)
  const service = createServiceClient()

  if (!isFirstTimeSet && !(await isVerifiedRecoverySession(supabase, user.id))) {
    const guarded = await requireAuth()
    if (guarded.error) return guarded.error
    if (guarded.user.id !== user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  let updateError:
    | { message?: string; status?: number; code?: string }
    | null
    | undefined = null
  let flagWriteOk = false

  if (isFirstTimeSet) {
    // One Auth write makes the transition indivisible. A successful password
    // set must never leave `has_password=false`, because that would let a later
    // AAL1 session reuse the first-password exception for an existing password.
    const { error } = await service.auth.admin.updateUserById(user.id, {
      password,
      app_metadata: { ...(user.app_metadata ?? {}), has_password: true },
    })
    updateError = error
    flagWriteOk = !error
  } else {
    const { error } = await supabase.auth.updateUser({ password })
    updateError = error
  }

  if (updateError) {
    log.warn('password update failed', {
      userId: user.id,
      isFirstTimeSet,
      code: updateError.code,
      status: updateError.status,
    })
    return NextResponse.json(
      {
        error:
          getUserErrorMessage(updateError) ||
          'Kunde inte uppdatera lösenord. Försök igen.',
      },
      { status: 400 },
    )
  }

  if (!isFirstTimeSet) {
    // Read-merge-write so legacy email users with an inferred password receive
    // the explicit marker without wiping sibling app_metadata keys.
    try {
      const { data: u } = await service.auth.admin.getUserById(user.id)
      const prior = u?.user?.app_metadata ?? {}
      await service.auth.admin.updateUserById(user.id, {
        app_metadata: { ...prior, has_password: true },
      })
      flagWriteOk = true
    } catch (err) {
      log.error('failed to flip has_password flag after successful password set', {
        userId: user.id,
        err,
      })
      // Existing-password authorization remains safe: missing metadata on a
      // non-BankID user is classified as already having a password.
    }
  }

  log.info('password set', { userId: user.id, isFirstTimeSet, flagWriteOk })

  return NextResponse.json({ data: { ok: true } })
}
