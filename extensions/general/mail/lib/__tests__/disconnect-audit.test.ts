/**
 * Mail credential mutations and their safe audit row must be one database
 * transaction. These tests pin the application boundary to the narrow RPCs:
 * no direct credential-table mutation and no best-effort audit insert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../crypto', () => ({
  encryptToken: (value: string) => `encrypted:${value}`,
  decryptToken: (value: string) => value.replace(/^encrypted:/, ''),
}))

import { disconnect, saveConnection, updateBackfill } from '../connections'

function mockSupabase(result: { data?: unknown; error?: { message: string } | null } = {}) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  const from = vi.fn(() => {
    throw new Error('credential mutations must not use a direct table write')
  })
  return { client: { rpc, from } as never, rpc, from }
}

beforeEach(() => vi.clearAllMocks())

describe('atomic mail connection audit RPCs', () => {
  it('atomically connects or reconnects with encrypted tokens', async () => {
    const { client, rpc, from } = mockSupabase()

    await saveConnection(client, {
      companyId: 'co-1',
      userId: 'user-1',
      provider: 'gmail',
      emailAddress: ' Owner@Example.com ',
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
      expiresAt: new Date('2026-08-10T12:00:00Z'),
      scopes: ['gmail.readonly'],
      backfillFrom: null,
    })

    expect(from).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('upsert_mail_connection_with_audit', {
      p_company_id: 'co-1',
      p_user_id: 'user-1',
      p_provider: 'gmail',
      p_email_address: 'owner@example.com',
      p_encrypted_refresh_token: 'encrypted:refresh-secret',
      p_encrypted_access_token: 'encrypted:access-secret',
      p_access_token_expires_at: '2026-08-10T12:00:00.000Z',
      p_scopes: ['gmail.readonly'],
      p_backfill_from: null,
    })
  })

  it('surfaces an audit or credential failure from connect instead of diverging', async () => {
    const { client } = mockSupabase({ error: { message: 'audit insert failed' } })
    await expect(saveConnection(client, {
      companyId: 'co-1',
      userId: 'user-1',
      provider: 'gmail',
      emailAddress: 'owner@example.com',
      refreshToken: 'refresh',
      accessToken: 'access',
      expiresAt: new Date('2026-08-10T12:00:00Z'),
      scopes: [],
      backfillFrom: null,
    })).rejects.toThrow('audit insert failed')
  })

  it('atomically disconnects and audits without selecting or logging tokens', async () => {
    const { client, rpc, from } = mockSupabase()

    await disconnect(client, 'co-1', 'conn-1', 'user-1')

    expect(from).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('disconnect_mail_connection_with_audit', {
      p_company_id: 'co-1',
      p_connection_id: 'conn-1',
      p_user_id: 'user-1',
    })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('token')
  })

  it('surfaces an audit failure from disconnect so the API cannot claim success', async () => {
    const { client } = mockSupabase({ error: { message: 'audit insert failed' } })
    await expect(disconnect(client, 'co-1', 'conn-1', 'user-1'))
      .rejects.toThrow('audit insert failed')
  })

  it('atomically updates and audits the backfill window', async () => {
    const { client, rpc, from } = mockSupabase()

    await updateBackfill(client, 'co-1', 'conn-1', 'user-1', '2026-05-12')

    expect(from).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('update_mail_connection_backfill_with_audit', {
      p_company_id: 'co-1',
      p_connection_id: 'conn-1',
      p_user_id: 'user-1',
      p_backfill_from: '2026-05-12',
    })
  })
})
