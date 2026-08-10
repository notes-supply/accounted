/**
 * Reading and maintaining mailbox grants.
 *
 * Every function here uses the service-role client: `mail_connections` has RLS
 * enabled with no policies precisely so a live refresh token can never be
 * selected by a browser session.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptToken, encryptToken } from './crypto'
import {
  MailTokenRefreshError,
  getGoogleOAuthEnv,
  refreshAccessToken,
} from './google-oauth'

export interface MailConnectionRow {
  id: string
  company_id: string
  provider: 'gmail' | 'microsoft'
  email_address: string
  encrypted_refresh_token: string
  encrypted_access_token: string | null
  access_token_expires_at: string | null
  scope_label: string | null
  status: 'active' | 'needs_reconsent' | 'revoked'
}

/** Safe projection for anything that answers a browser. Never includes tokens. */
export interface MailConnectionSummary {
  id: string
  provider: 'gmail' | 'microsoft'
  emailAddress: string
  scopeLabel: string | null
  status: 'active' | 'needs_reconsent' | 'revoked'
  lastSearchedAt: string | null
  lastErrorCode: string | null
}

export async function listConnections(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MailConnectionSummary[]> {
  const { data } = await supabase
    .from('mail_connections')
    .select('id, provider, email_address, scope_label, status, last_searched_at, last_error_code')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    provider: row.provider as 'gmail' | 'microsoft',
    emailAddress: row.email_address as string,
    scopeLabel: (row.scope_label as string | null) ?? null,
    status: row.status as MailConnectionSummary['status'],
    lastSearchedAt: (row.last_searched_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
  }))
}

export async function listActiveConnections(
  supabase: SupabaseClient,
  companyId: string,
  limit: number,
): Promise<MailConnectionRow[]> {
  const { data } = await supabase
    .from('mail_connections')
    .select(
      'id, company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scope_label, status',
    )
    .eq('company_id', companyId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(limit)
  return (data ?? []) as MailConnectionRow[]
}

/**
 * Upsert on (company, provider, address) so reconnecting the same mailbox
 * refreshes the grant instead of creating a twin that gets searched twice.
 */
export async function saveConnection(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    provider: 'gmail' | 'microsoft'
    emailAddress: string
    refreshToken: string
    accessToken: string
    expiresAt: Date
    scopes: string[]
    backfillFrom: string | null
  },
): Promise<void> {
  const { error } = await supabase.rpc('upsert_mail_connection_with_audit', {
    p_company_id: params.companyId,
    p_user_id: params.userId,
    p_provider: params.provider,
    p_email_address: params.emailAddress.trim().toLowerCase(),
    p_encrypted_refresh_token: encryptToken(params.refreshToken),
    p_encrypted_access_token: encryptToken(params.accessToken),
    p_access_token_expires_at: params.expiresAt.toISOString(),
    p_scopes: params.scopes,
    p_backfill_from: params.backfillFrom,
  })
  if (error) throw new Error(`Failed to save mail connection: ${error.message}`)
}

async function markNeedsReconsent(
  supabase: SupabaseClient,
  connectionId: string,
  code: string,
): Promise<void> {
  await supabase
    .from('mail_connections')
    .update({ status: 'needs_reconsent', last_error_code: code, last_error_at: new Date().toISOString() })
    .eq('id', connectionId)
}

/**
 * A usable access token for one connection, refreshing when it has expired.
 *
 * Returns null rather than throwing when the grant is dead: one revoked
 * mailbox must shrink the hunt, never abort it.
 */
export async function getAccessToken(
  supabase: SupabaseClient,
  connection: MailConnectionRow,
  origin: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null
  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at)
    : null
  // 60s of slack so a token cannot expire mid-request.
  if (connection.encrypted_access_token && expiresAt && expiresAt.getTime() - 60_000 > Date.now()) {
    try {
      return decryptToken(connection.encrypted_access_token)
    } catch {
      // Fall through to a refresh: an undecryptable token means the key
      // rotated, which a refresh repairs.
    }
  }

  try {
    const env = getGoogleOAuthEnv(origin)
    const refreshToken = decryptToken(connection.encrypted_refresh_token)
    const refreshed = await refreshAccessToken(env, refreshToken, signal)
    if (signal?.aborted) return null
    await supabase
      .from('mail_connections')
      .update({
        encrypted_access_token: encryptToken(refreshed.accessToken),
        access_token_expires_at: refreshed.expiresAt.toISOString(),
      })
      .eq('id', connection.id)
    return refreshed.accessToken
  } catch (error) {
    if (signal?.aborted) return null
    if (error instanceof MailTokenRefreshError && error.permanent) {
      await markNeedsReconsent(supabase, connection.id, 'invalid_grant')
    }
    return null
  }
}

export async function touchSearched(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<void> {
  await supabase
    .from('mail_connections')
    .update({ last_searched_at: new Date().toISOString() })
    .eq('id', connectionId)
}

export async function disconnect(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc('disconnect_mail_connection_with_audit', {
    p_company_id: companyId,
    p_connection_id: connectionId,
    p_user_id: userId,
  })
  if (error) throw new Error(`Failed to disconnect mail connection: ${error.message}`)
}

export async function updateBackfill(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
  userId: string,
  backfillFrom: string,
): Promise<void> {
  const { error } = await supabase.rpc('update_mail_connection_backfill_with_audit', {
    p_company_id: companyId,
    p_connection_id: connectionId,
    p_user_id: userId,
    p_backfill_from: backfillFrom,
  })
  if (error) throw new Error(`Failed to update mail connection: ${error.message}`)
}
