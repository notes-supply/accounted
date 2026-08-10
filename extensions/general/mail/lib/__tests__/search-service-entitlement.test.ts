import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasCapability: vi.fn(),
  supabaseFrom: vi.fn(),
  searchMessageIds: vi.fn(),
  getMessageSummary: vi.fn(),
  fetchAttachmentBytes: vi.fn(),
  refreshAccessToken: vi.fn(),
  listActiveConnections: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from: mocks.supabaseFrom }),
}))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: mocks.hasCapability }))
vi.mock('../gmail-client', () => ({
  MAX_RESULTS: 8,
  describeAttachment: vi.fn(),
  fetchAttachmentBytes: mocks.fetchAttachmentBytes,
  getMessageSummary: mocks.getMessageSummary,
  searchMessageIds: mocks.searchMessageIds,
}))
vi.mock('../connections', () => ({
  getAccessToken: mocks.refreshAccessToken,
  listActiveConnections: mocks.listActiveConnections,
  touchSearched: vi.fn(),
}))
vi.mock('../google-oauth', () => ({ isGoogleMailConfigured: () => true }))

import { GmailSearchService } from '../search-service'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hasCapability.mockResolvedValue(false)
})

describe('GmailSearchService entitlement boundary', () => {
  it('does not read credentials, refresh tokens, or call Gmail when search is not entitled', async () => {
    const service = new GmailSearchService()

    await expect(service.search('co-free', {
      merchant: 'vendor',
      amount: 100,
      currency: 'SEK',
      date: '2026-08-10',
    })).resolves.toEqual([])

    expect(mocks.supabaseFrom).not.toHaveBeenCalled()
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled()
    expect(mocks.searchMessageIds).not.toHaveBeenCalled()
  })

  it('does not read credentials, refresh tokens, or fetch Gmail attachments when not entitled', async () => {
    const service = new GmailSearchService()

    await expect(service.fetchAttachment('co-free', 'conn-1', 'msg-1', 'att-1'))
      .resolves.toBeNull()

    expect(mocks.supabaseFrom).not.toHaveBeenCalled()
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled()
    expect(mocks.fetchAttachmentBytes).not.toHaveBeenCalled()
  })

  it('shares one result budget across bounded mailboxes', async () => {
    mocks.hasCapability.mockResolvedValue(true)
    mocks.listActiveConnections.mockResolvedValue(
      ['conn-1', 'conn-2', 'conn-3'].map((id) => ({
        id,
        company_id: 'co-1',
        provider: 'gmail',
        email_address: `${id}@example.com`,
      })),
    )
    mocks.refreshAccessToken.mockResolvedValue('access-token')
    mocks.searchMessageIds.mockImplementation(
      async (_token: string, _query: string, limit: number) =>
        Array.from({ length: limit }, (_, index) => `msg-${limit}-${index}`),
    )
    mocks.getMessageSummary.mockImplementation(
      async (_token: string, messageId: string, connectionId: string, mailbox: string) => ({
        connectionId,
        mailbox,
        provider: 'gmail',
        messageId,
        subject: 'invoice receipt',
        from: 'billing@example.com',
        receivedAt: null,
        attachmentIds: ['att-1'],
        bodyIsReceipt: false,
      }),
    )

    const result = await new GmailSearchService().search('co-1', {
      merchant: 'vendor',
      amount: 100,
      currency: 'SEK',
      date: '2026-08-10',
      limit: 8,
    })

    expect(mocks.searchMessageIds.mock.calls.map((call) => call[2])).toEqual([3, 3, 2])
    expect(result).toHaveLength(8)
  })
})
