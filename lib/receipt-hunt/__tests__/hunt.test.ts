/**
 * huntCompany's read/write shell. The ranking is covered in select.test.ts;
 * what matters here is that a dry run cannot write, and that a real run stages
 * exactly one operation per proposal with the shape the approval card reads.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

const mockExtractMailDocuments = vi.hoisted(() => vi.fn())
const mockIngestMailCandidate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn(() => Promise.resolve(true)),
}))
vi.mock('../mail-intelligence', () => ({
  extractMailDocuments: (...args: unknown[]) => mockExtractMailDocuments(...args),
}))
vi.mock('../ingest', () => ({
  ingestMailCandidate: (...args: unknown[]) => mockIngestMailCandidate(...args),
  mailMessageIdentity: (
    candidate: { provider: string; connectionId: string; messageId: string },
  ) => `${candidate.provider}::${candidate.connectionId}::${candidate.messageId}`,
  mailAttachmentIdentity: (
    candidate: { provider: string; connectionId: string; messageId: string },
    attachmentId: string,
  ) => `${candidate.provider}::${candidate.connectionId}::${candidate.messageId}::${attachmentId}`,
}))

import { hasCapability } from '@/lib/entitlements/has-capability'
import { registerMailSearchService, type MailCandidate } from '@/lib/mail-search/service'
import { huntCompany } from '../hunt'

type Row = Record<string, unknown>

/**
 * Minimal PostgREST stand-in: every builder method returns the chain, and
 * awaiting it yields whatever the table was seeded with. `range` is honoured so
 * fetchAllRows terminates.
 */
function mockSupabase(tables: Record<string, Row[]>) {
  const inserts: Array<{ table: string; rows: Row[] }> = []
  const rpcCalls: Array<{
    name: string
    args: Record<string, unknown>
    abortSignal: ReturnType<typeof vi.fn>
  }> = []
  const client = {
    from(table: string) {
      let from = 0
      let to = Number.MAX_SAFE_INTEGER
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'not', 'in', 'lte', 'gte', 'order', 'limit']) {
        chain[m] = vi.fn(() => chain)
      }
      chain.range = vi.fn((f: number, t: number) => {
        from = f
        to = t
        return chain
      })
      chain.insert = vi.fn((rows: Row[]) => {
        inserts.push({ table, rows })
        return Promise.resolve({ error: null })
      })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null }).then(resolve)
      return chain
    },
    rpc(name: string, args: Record<string, unknown>) {
      const call = { name, args, abortSignal: vi.fn() }
      rpcCalls.push(call)
      const result = {
        abortSignal(signal: AbortSignal) {
          call.abortSignal(signal)
          return result
        },
        then(resolve: (value: unknown) => unknown) {
          const rows = args.p_rows as Row[]
          return Promise.resolve({ data: rows.length, error: null }).then(resolve)
        },
      }
      return result
    },
  }
  return { client: client as never, inserts, rpcCalls }
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString()
}

const TX = {
  id: 'tx-1',
  company_id: 'co-1',
  date: '2026-05-02',
  description: 'CIRCLE K 421',
  merchant_name: 'Circle K',
  amount: -438.75,
  currency: 'SEK',
  amount_sek: -438.75,
  exchange_rate: null,
}

const ITEM = {
  id: 'item-1',
  document_id: 'doc-1',
  extracted_data: {
    supplier: { name: 'Circle K' },
    invoice: { invoiceDate: '2026-05-02', currency: 'SEK' },
    totals: { total: 438.75, vatAmount: 87.75 },
  },
  channel_context: null,
}

function fixture() {
  return {
    transactions: [TX],
    invoice_inbox_items: [ITEM],
    document_attachments: [{ id: 'doc-1', file_name: 'circlek.pdf' }],
    pending_operations: [],
    company_members: [{ user_id: 'user-1', role: 'owner' }],
  }
}

beforeEach(() => {
  vi.mocked(hasCapability).mockReset().mockResolvedValue(true)
  mockExtractMailDocuments.mockReset()
  mockIngestMailCandidate.mockReset().mockResolvedValue({
    documentId: 'doc-mail',
    inboxItemId: 'inbox-mail',
    fileName: 'invoice.pdf',
    mailbox: 'owner@example.com',
  })
})

describe('huntCompany', () => {
  it('does no hunt processing when mail search is requested without AI entitlement', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { client, inserts } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', {
      searchMail: true,
      deadlineAt: futureDeadline(),
    })

    expect(result).toMatchObject({ companyId: 'co-1', skippedNoAiEntitlement: true, proposed: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('does not stage existing-pool proposals without AI entitlement', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { client, inserts } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', { deadlineAt: futureDeadline() })

    expect(result).toMatchObject({ companyId: 'co-1', skippedNoAiEntitlement: true, proposed: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('writes nothing on a dry run but returns what it would have staged', async () => {
    const { client, inserts, rpcCalls } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', { dryRun: true })

    expect(inserts).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
    expect(result.proposed).toBe(1)
    expect(result.proposals?.[0]).toMatchObject({ transaction_id: 'tx-1', document_id: 'doc-1' })
  })

  it('stages one operation per proposal, shaped for the approval card', async () => {
    const { client, inserts, rpcCalls } = mockSupabase(fixture())

    const deadlineAt = futureDeadline()
    const result = await huntCompany(client, 'co-1', 'run-1', { deadlineAt })

    expect(result.proposed).toBe(1)
    expect(inserts).toHaveLength(0)
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]).toMatchObject({
      name: 'stage_receipt_hunt_proposals',
      args: {
        p_company_id: 'co-1',
        p_run_id: 'run-1',
        p_deadline_at: deadlineAt,
      },
    })
    expect(rpcCalls[0].abortSignal).not.toHaveBeenCalled()
    const [row] = rpcCalls[0].args.p_rows as Array<Record<string, Record<string, unknown>>>
    expect(row.operation_type).toBe('attach_document_to_transaction')
    // The executor reads exactly these two params and nothing else.
    expect(row.params).toEqual({ transaction_id: 'tx-1', document_id: 'doc-1' })
    // AttachDocumentPreview treats an absent flag as potentially destructive,
    // so it has to be present and false or the card warns about an overwrite
    // that cannot happen (these transactions have no document).
    expect(row.preview_data.existing_document_is_rakenskapsinformation).toBe(false)
    expect(row.preview_data.will_overwrite_existing).toBe(false)
    expect(row.agent_metadata.run_id).toBe('run-1')
    expect(row.actor_type).toBe('cron')
  })

  it('does not write a proposal if AI entitlement expires during the hunt', async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { client, inserts } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', { deadlineAt: futureDeadline() })

    expect(result).toMatchObject({ skippedNoAiEntitlement: true, proposed: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('does not stage when the company has no members to ask', async () => {
    const tables = { ...fixture(), company_members: [] }
    const { client, inserts } = mockSupabase(tables)

    const result = await huntCompany(client, 'co-1', 'run-1', { deadlineAt: futureDeadline() })

    expect(result.skippedNoOwner).toBe(true)
    expect(result.proposed).toBe(0)
    expect(inserts).toHaveLength(0)
  })

  it('ignores a receipt whose document is already anchored to a verifikat', async () => {
    // document_attachments is filtered on journal_entry_id IS NULL by the
    // query, so an anchored doc simply is not in the attachable set.
    const tables = { ...fixture(), document_attachments: [] }
    const { client, inserts } = mockSupabase(tables)

    const result = await huntCompany(client, 'co-1', 'run-1', { deadlineAt: futureDeadline() })

    expect(result.poolSize).toBe(0)
    expect(result.proposed).toBe(0)
    expect(inserts).toHaveLength(0)
  })

  it('does not collapse recurring receipts with the same vendor and filename across messages', async () => {
    const messages: MailCandidate[] = ['msg-july', 'msg-august'].map((messageId, index) => ({
      connectionId: 'conn-1',
      mailbox: 'owner@example.com',
      provider: 'gmail',
      messageId,
      subject: 'Monthly invoice',
      from: 'billing@example.com',
      receivedAt: `2026-0${index + 7}-01T00:00:00Z`,
      attachmentIds: [`att-${index + 1}`],
      attachmentNames: ['invoice.pdf'],
      bodyIsReceipt: false,
    }))
    registerMailSearchService({
      isConfigured: () => true,
      search: vi.fn().mockResolvedValue(messages),
      fetchAttachment: vi.fn(),
    })
    mockExtractMailDocuments.mockResolvedValue(messages.map((message) => ({
      messageId: `${message.provider}::${message.connectionId}::${message.messageId}`,
      attachmentName: 'invoice.pdf',
      vendor: 'Same Vendor AB',
      date: '2026-05-02',
      amount: 438.75,
      currency: 'SEK',
    })))
    const { client } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', {
      searchMail: true,
      deadlineAt: futureDeadline(),
    })

    expect(result.mail?.withCandidates).toBe(2)
    expect(mockIngestMailCandidate).toHaveBeenCalledTimes(2)
  })

  it('keeps equal provider message ids distinct across connections and fetches each attachment', async () => {
    const messages: MailCandidate[] = ['conn-1', 'conn-2'].map((connectionId, index) => ({
      connectionId,
      mailbox: `${connectionId}@example.com`,
      provider: 'gmail',
      messageId: 'shared-provider-id',
      subject: `Receipt ${connectionId}`,
      from: 'billing@example.com',
      receivedAt: '2026-05-02T10:00:00Z',
      attachmentIds: [`att-${index + 1}`],
      attachmentNames: [`receipt-${index + 1}.pdf`],
      bodyIsReceipt: false,
    }))
    registerMailSearchService({
      isConfigured: () => true,
      search: vi.fn().mockResolvedValue(messages),
      fetchAttachment: vi.fn(),
    })
    mockExtractMailDocuments.mockImplementation(async (reviewed: Array<{ messageId: string }>) => {
      expect(reviewed.map((mail) => mail.messageId)).toEqual([
        'gmail::conn-1::shared-provider-id',
        'gmail::conn-2::shared-provider-id',
      ])
      return reviewed.map((mail, index) => ({
        messageId: mail.messageId,
        attachmentName: `receipt-${index + 1}.pdf`,
        vendor: 'Circle K',
        date: '2026-05-02',
        amount: 438.75,
        currency: 'SEK',
      }))
    })
    const { client } = mockSupabase(fixture())

    const result = await huntCompany(client, 'co-1', 'run-1', {
      searchMail: true,
      deadlineAt: futureDeadline(),
    })

    expect(result.mail?.withCandidates).toBe(2)
    expect(mockIngestMailCandidate).toHaveBeenCalledTimes(2)
    expect(mockIngestMailCandidate.mock.calls.map((call) => {
      const selected = call[3] as MailCandidate
      return [selected.connectionId, selected.messageId, selected.attachmentIds[0]]
    })).toEqual([
      ['conn-1', 'shared-provider-id', 'att-1'],
      ['conn-2', 'shared-provider-id', 'att-2'],
    ])
  })

  it('fails closed before reads when a mutating run lacks a valid future DB deadline', async () => {
    const { client, inserts, rpcCalls } = mockSupabase(fixture())

    await expect(huntCompany(client, 'co-1', 'run-1')).rejects.toThrow(/deadline/i)
    await expect(huntCompany(client, 'co-1', 'run-1', {
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    })).rejects.toThrow(/deadline/i)

    expect(inserts).toHaveLength(0)
    expect(rpcCalls).toHaveLength(0)
  })
})
