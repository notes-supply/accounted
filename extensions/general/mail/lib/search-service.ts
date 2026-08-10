/**
 * The Gmail implementation of the core MailSearchService contract.
 *
 * Query-then-classify, never sync: for each purchase we run a provider-side
 * search, pull metadata for the few hits, and let the caller decide. No mailbox
 * is mirrored, no message body is stored, and nothing is written back to the
 * mailbox. That is what keeps this inside Google's Limited Use terms and inside
 * GDPR data minimisation, and it is the promise the consent screen makes.
 */
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type {
  FetchedAttachment,
  MailCandidate,
  MailSearchQuery,
  MailSearchService,
} from '@/lib/mail-search/service'
import { buildGmailQuery, looksLikeReceipt } from './gmail-query'
import {
  describeAttachment,
  fetchAttachmentBytes,
  getMessageSummary,
  MAX_RESULTS,
  searchMessageIds,
} from './gmail-client'
import {
  getAccessToken,
  listActiveConnections,
  touchSearched,
  type MailConnectionRow,
} from './connections'
import { isGoogleMailConfigured } from './google-oauth'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

const log = createLogger('mail-search')
export const MAX_MAIL_CONNECTIONS_PER_COMPANY = 5

/**
 * Origin used to rebuild the redirect_uri during a token refresh. Google
 * requires the same value the grant was issued against, so it is derived from
 * the deployment's canonical URL rather than a request that may not exist
 * (the hunt runs from a cron, with no browser origin to borrow).
 */
function canonicalOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000'
}

export class GmailSearchService implements MailSearchService {
  isConfigured(): boolean {
    return isGoogleMailConfigured()
  }

  async search(
    companyId: string,
    query: MailSearchQuery,
    signal?: AbortSignal,
  ): Promise<MailCandidate[]> {
    if (!this.isConfigured()) return []

    const supabase = createServiceClientNoCookies()
    if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) return []
    if (signal?.aborted) return []
    const requestedLimit = Number.isSafeInteger(query.limit) && (query.limit ?? 0) > 0
      ? Math.min(query.limit as number, MAX_RESULTS)
      : MAX_RESULTS
    const connectionLimit = Math.min(MAX_MAIL_CONNECTIONS_PER_COMPANY, requestedLimit)
    const connections = await listActiveConnections(supabase, companyId, connectionLimit)
    if (signal?.aborted) return []
    if (connections.length === 0) return []

    const q = buildGmailQuery(query)

    // Mailboxes are searched in parallel: the work is read-only, so there is
    // nothing to serialise, and one slow account should not delay the rest.
    const base = Math.floor(requestedLimit / connections.length)
    const remainder = requestedLimit % connections.length
    const perConnection = await Promise.all(
      connections.map((connection, index) => this.searchOne(
        supabase,
        connection,
        q,
        base + (index < remainder ? 1 : 0),
        signal,
      )),
    )
    return perConnection.flat().slice(0, requestedLimit)
  }

  private async searchOne(
    supabase: ReturnType<typeof createServiceClientNoCookies>,
    connection: MailConnectionRow,
    q: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MailCandidate[]> {
    // A dead grant shrinks the hunt rather than aborting it; getAccessToken has
    // already parked it as needs_reconsent for the UI to surface.
    const accessToken = await getAccessToken(supabase, connection, canonicalOrigin(), signal)
    if (!accessToken) return []

    try {
      const ids = await searchMessageIds(accessToken, q, limit, signal)
      if (ids.length === 0) return []

      const summaries = await Promise.all(
        ids.map((id) =>
          getMessageSummary(accessToken, id, connection.id, connection.email_address, signal),
        ),
      )
      if (signal?.aborted) return []
      await touchSearched(supabase, connection.id)

      // Cheap pre-filter before anything expensive looks at these.
      return summaries.filter((c) => looksLikeReceipt(c.subject, c.from))
    } catch (error) {
      // Never let one mailbox's failure surface as the company's failure.
      log.warn('gmail search failed for connection', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  async fetchAttachment(
    companyId: string,
    connectionId: string,
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<FetchedAttachment | null> {
    const supabase = createServiceClientNoCookies()
    if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) return null
    if (signal?.aborted) return null
    const { data } = await supabase
      .from('mail_connections')
      .select(
        'id, company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scope_label, status',
      )
      .eq('id', connectionId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!data) return null
    if (signal?.aborted) return null

    const accessToken = await getAccessToken(
      supabase,
      data as MailConnectionRow,
      canonicalOrigin(),
      signal,
    )
    if (!accessToken) return null
    if (signal?.aborted) return null

    const [bytes, described] = await Promise.all([
      fetchAttachmentBytes(accessToken, messageId, attachmentId, signal),
      describeAttachment(accessToken, messageId, attachmentId, signal),
    ])
    if (signal?.aborted) return null
    if (!bytes) return null

    return {
      filename: described?.filename ?? 'underlag.pdf',
      mimeType: described?.mimeType ?? 'application/octet-stream',
      bytes,
    }
  }
}
