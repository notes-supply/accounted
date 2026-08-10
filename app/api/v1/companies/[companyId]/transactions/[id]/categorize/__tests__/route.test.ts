/**
 * Tests for POST /api/v1/companies/{companyId}/transactions/{id}/categorize.
 *
 * Focus: settlement provenance and truthful post-attachment compensation.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const {
  createTxJE,
  compensateTransactionCategorizationMock,
  findMissingAccountsMock,
  reverseEntryMock,
  saveUserMappingRuleMock,
  upsertCounterpartyTemplateMock,
} = vi.hoisted(() => ({
  createTxJE: vi.fn().mockResolvedValue({ id: 'je-fresh' }),
  compensateTransactionCategorizationMock: vi.fn(
    async (
      supabase: { rpc: (name: string, args: Record<string, string>) => Promise<{ data: unknown; error: unknown }> },
      params: { companyId: string; transactionId: string; originalJournalEntryId: string },
    ) => {
      const { data, error } = await supabase.rpc('compensate_transaction_categorization', {
        p_company_id: params.companyId,
        p_transaction_id: params.transactionId,
        p_original_journal_entry_id: params.originalJournalEntryId,
      })
      const row = data as {
        status?: string
        original_journal_entry_id?: string
        reversal_journal_entry_ids?: string[]
        original_pointer_cleared?: boolean
      } | null
      const reversalIds = row?.reversal_journal_entry_ids ?? []
      const partialPostedIds: Record<string, string> = {
        journal_entry_id: params.originalJournalEntryId,
      }
      reversalIds.forEach((id, index) => {
        partialPostedIds[
          index === 0 ? 'reversal_journal_entry_id' : `reversal_journal_entry_${index + 1}_id`
        ] = id
      })
      const compensationVerified =
        !error &&
        row?.original_journal_entry_id === params.originalJournalEntryId &&
        row.original_pointer_cleared === true &&
        reversalIds.length === 1 &&
        ['reversed', 'already_reversed', 'recovered_existing_reversal'].includes(row.status ?? '')
      return compensationVerified
        ? {
            compensationVerified: true as const,
            status: row!.status,
            originalEntry: { id: params.originalJournalEntryId },
            reversalEntry: { id: reversalIds[0] },
          }
        : { compensationVerified: false as const, partialPostedIds, error: new Error('unverified') }
    },
  ),
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
  reverseEntryMock: vi.fn().mockResolvedValue(undefined),
  saveUserMappingRuleMock: vi.fn().mockResolvedValue(undefined),
  upsertCounterpartyTemplateMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: reverseEntryMock,
  compensateTransactionCategorization: compensateTransactionCategorizationMock,
}))
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return { ...actual, findUnresolvableAccounts: findMissingAccountsMock }
})
// Best-effort learning writes: not part of this surface.
vi.mock('@/lib/bookkeeping/counterparty-templates', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/bookkeeping/counterparty-templates')
  >('@/lib/bookkeeping/counterparty-templates')
  return { ...actual, upsertCounterpartyTemplate: upsertCounterpartyTemplateMock }
})
vi.mock('@/lib/bookkeeping/mapping-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/mapping-engine')>(
    '@/lib/bookkeeping/mapping-engine',
  )
  return { ...actual, saveUserMappingRule: saveUserMappingRuleMock }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { PostCommitReadbackError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events/bus'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  // Insert payloads are recorded verbatim: the proxy would happily accept a
  // phantom column, so the assertion has to inspect the object itself.
  const inserts: Record<string, unknown[]> = {}
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          if (prop === 'insert') (inserts[table] ??= []).push(args[0])
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  const supabase = {
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn((fn: string) => buildChain(`rpc:${fn}`)),
  }
  return { supabase, inserts }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const compensationSuccess = {
  data: {
    status: 'reversed',
    original_journal_entry_id: 'je-fresh',
    reversal_journal_entry_ids: ['je-storno'],
    original_pointer_cleared: true,
  },
  error: null,
}

function makeRequest(body: unknown): Request {
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
      },
      body: JSON.stringify(body),
    },
  )
}
function routeParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) }
}

function casRaceSupabase(compensation: MockResult = compensationSuccess) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: {
      data: {
        id: TX_ID,
        company_id: COMPANY_ID,
        date: '2026-05-12',
        amount: -349.5,
        currency: 'SEK',
        merchant_name: 'ICA',
        cash_account_id: null,
        journal_entry_id: null,
      },
      error: null,
    },
    company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
    fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    'rpc:attach_transaction_categorization': { data: false, error: null },
    'rpc:compensate_transaction_categorization': compensation,
  })
}

const uncategorizedTransaction = {
  id: TX_ID,
  company_id: COMPANY_ID,
  date: '2026-05-12',
  amount: -349.5,
  currency: 'SEK',
  merchant_name: 'ICA',
  cash_account_id: null,
  journal_entry_id: null,
}

const verifiedCategorizedTransaction = {
  ...uncategorizedTransaction,
  category: 'expense_office',
  is_business: true,
  journal_entry_id: 'je-fresh',
}

function postAttachmentReadbackSupabase(
  readback: MockResult,
  compensation: MockResult = compensationSuccess,
) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: [
      { data: uncategorizedTransaction, error: null },
      readback,
    ],
    company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
    fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    'rpc:attach_transaction_categorization': { data: true, error: null },
    'rpc:compensate_transaction_categorization': compensation,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  findMissingAccountsMock.mockResolvedValue([])
  reverseEntryMock.mockResolvedValue(undefined)
  createTxJE.mockResolvedValue({ id: 'je-fresh' })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/.../transactions/{id}/categorize CAS race', () => {
  it('returns a typed database error and creates no voucher when company settings cannot be read', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          cash_account_id: null,
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: {
        data: null,
        error: { message: 'permission denied', code: '42501' },
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: false }),
      routeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { operation: 'fetch_company_settings' },
    })
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('returns exact posted metadata as a no-write idempotent success', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          journal_entry_id: 'je-posted',
          category: 'expense_office',
          is_business: true,
        },
        error: null,
      },
      journal_entries: {
        data: {
          id: 'je-posted',
          company_id: COMPANY_ID,
          status: 'posted',
          source_type: 'bank_transaction',
          source_id: TX_ID,
          categorization_category: 'expense_office',
          categorization_is_business: true,
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toMatchObject({
      journal_entry_id: 'je-posted',
      category: 'expense_office',
      already_had_journal_entry: true,
    })
    expect(
      supabase.from.mock.calls.filter(([table]: [string]) => table === 'transactions'),
    ).toHaveLength(1)
  })

  it.each([
    {
      name: 'category change',
      request: { is_business: true, category: 'expense_software' },
      journalCategory: 'expense_office',
      journalBusiness: true,
      reason: 'requested_change',
    },
    {
      name: 'legacy null metadata',
      request: { is_business: true, category: 'expense_office' },
      journalCategory: null,
      journalBusiness: null,
      reason: 'metadata_unprovable',
    },
  ])('fails closed for $name on an existing journal', async (testCase) => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          journal_entry_id: 'je-posted',
          category: 'expense_office',
          is_business: true,
        },
        error: null,
      },
      journal_entries: {
        data: {
          id: 'je-posted',
          company_id: COMPANY_ID,
          status: 'posted',
          source_type: 'bank_transaction',
          source_id: TX_ID,
          categorization_category: testCase.journalCategory,
          categorization_is_business: testCase.journalBusiness,
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest(testCase.request), routeParams())
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: { reason: testCase.reason },
    })
    expect(
      supabase.from.mock.calls.filter(([table]: [string]) => table === 'transactions'),
    ).toHaveLength(1)
  })

  it('fails closed when existing journal metadata query errors', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          journal_entry_id: 'je-posted',
          category: 'expense_office',
          is_business: true,
        },
        error: null,
      },
      journal_entries: { data: null, error: { message: 'read timeout' } },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { operation: 'verify_existing_transaction_categorization' },
    })
    expect(
      supabase.from.mock.calls.filter(([table]: [string]) => table === 'transactions'),
    ).toHaveLength(1)
  })

  it('rejects mapping-affecting input on an existing journal', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          journal_entry_id: 'je-posted',
          category: 'expense_office',
          is_business: true,
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({
        is_business: true,
        category: 'expense_office',
        account_override: '6250',
      }),
      routeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: {
        reason: 'mapping_affecting_change',
        fields: ['account_override'],
      },
    })
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entries')
  })

  it('surfaces the posted id and writes no voucher gap when storno fails', async () => {
    const { supabase, inserts } = casRaceSupabase({
      data: null,
      error: { message: 'period locked' },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(body.error.details).toEqual({
      partial_posted_ids: { journal_entry_id: 'je-fresh' },
    })
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })

  it('compensates a readback-unverified posting and discloses its durable id', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          cash_account_id: null,
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:compensate_transaction_categorization': {
        data: null,
        error: { message: 'compensation timeout' },
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockRejectedValueOnce(
      new PostCommitReadbackError('je-readback', 42, 'timeout'),
    )

    const res = await POST(makeRequest({ is_business: false }), routeParams())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: {
        operation: 'commit_entry.readback',
        journal_entry_id: 'je-readback',
        voucher_number: 42,
        partial_posted_ids: { journal_entry_id: 'je-readback' },
      },
    })
    expect(supabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      expect.objectContaining({ p_original_journal_entry_id: 'je-readback' }),
    )
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.anything(),
    )
  })

  it('writes no gap explanation when the storno succeeds (the series stays unbroken)', async () => {
    const { supabase, inserts } = casRaceSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(saveUserMappingRuleMock).not.toHaveBeenCalled()
    expect(upsertCounterpartyTemplateMock).not.toHaveBeenCalled()
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })

  it('uses exact company-scoped cash-account and ledger provenance', async () => {
    const categorized = vi.fn()
    eventBus.on('transaction.categorized', categorized)
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            ...uncategorizedTransaction,
            cash_account_id: 'cash-revolut-sek',
          },
          error: null,
        },
        {
          data: {
            ...verifiedCategorizedTransaction,
            cash_account_id: 'cash-revolut-sek',
            description: 'Fresh attached state',
          },
          error: null,
        },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      cash_accounts: { data: { ledger_account: '1931' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: true, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    expect(res.status).toBe(200)
    expect(createTxJE).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: TX_ID }),
      expect.objectContaining({ credit_account: '1931' }),
      undefined,
      { category: 'expense_office', isBusiness: true },
    )
    expect(supabase.rpc).toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.objectContaining({
        p_company_id: COMPANY_ID,
        p_transaction_id: TX_ID,
        p_expected_cash_account_id: 'cash-revolut-sek',
        p_expected_settlement_account: '1931',
        p_expected_journal_entry_id: null,
        p_journal_entry_id: 'je-fresh',
      }),
    )
    const attachmentOrder = supabase.rpc.mock.invocationCallOrder[0]
    expect(attachmentOrder).toBeLessThan(saveUserMappingRuleMock.mock.invocationCallOrder[0])
    expect(attachmentOrder).toBeLessThan(upsertCounterpartyTemplateMock.mock.invocationCallOrder[0])
    expect(upsertCounterpartyTemplateMock).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      expect.objectContaining({
        id: TX_ID,
        category: 'expense_office',
        is_business: true,
        journal_entry_id: 'je-fresh',
        cash_account_id: 'cash-revolut-sek',
        description: 'Fresh attached state',
      }),
      expect.objectContaining({ credit_account: '1931' }),
      'user_approved',
    )
    expect(categorized).toHaveBeenCalledWith(expect.objectContaining({
      transaction: expect.objectContaining({
        id: TX_ID,
        company_id: COMPANY_ID,
        category: 'expense_office',
        is_business: true,
        journal_entry_id: 'je-fresh',
        cash_account_id: 'cash-revolut-sek',
        description: 'Fresh attached state',
      }),
    }))
  })

  it.each([
    { label: 'missing row', readback: { data: null, error: null } },
    {
      label: 'ambiguous row',
      readback: { data: null, error: { message: 'JSON object requested, multiple rows returned' } },
    },
    {
      label: 'wrong tenant',
      readback: { data: { ...verifiedCategorizedTransaction, company_id: 'company-other' }, error: null },
    },
    {
      label: 'wrong transaction id',
      readback: { data: { ...verifiedCategorizedTransaction, id: 'tx-other' }, error: null },
    },
    {
      label: 'stale category',
      readback: { data: { ...verifiedCategorizedTransaction, category: 'expense_software' }, error: null },
    },
    {
      label: 'stale business flag',
      readback: { data: { ...verifiedCategorizedTransaction, is_business: false }, error: null },
    },
    {
      label: 'wrong journal entry',
      readback: { data: { ...verifiedCategorizedTransaction, journal_entry_id: 'je-other' }, error: null },
    },
    {
      label: 'wrong cash account',
      readback: { data: { ...verifiedCategorizedTransaction, cash_account_id: 'cash-other' }, error: null },
    },
    {
      label: 'read error',
      readback: { data: null, error: { message: 'read timeout', code: '57014' } },
    },
  ])('compensates and publishes no event on $label post-attachment readback', async ({ readback }) => {
    const categorized = vi.fn()
    eventBus.on('transaction.categorized', categorized)
    const { supabase } = postAttachmentReadbackSupabase(readback)
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    expect([409, 500]).toContain(res.status)
    expect(categorized).not.toHaveBeenCalled()
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledWith(
      supabase,
      {
        companyId: COMPANY_ID,
        userId: 'user-1',
        transactionId: TX_ID,
        originalJournalEntryId: 'je-fresh',
      },
    )
    expect(upsertCounterpartyTemplateMock).not.toHaveBeenCalled()
  })

  it('returns an ordinary database error without a partial marker when storno succeeds', async () => {
    const { supabase } = casRaceSupabase()
    supabase.rpc.mockImplementationOnce(() => ({
      then: (resolve: (value: unknown) => void) => resolve({
        data: null,
        error: { message: 'connection reset', code: '08006' },
      }),
    }) as never)
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )
    const body = await res.json()

    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details).not.toHaveProperty('partial_posted_ids')
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(saveUserMappingRuleMock).not.toHaveBeenCalled()
    expect(upsertCounterpartyTemplateMock).not.toHaveBeenCalled()
  })

  it('exposes the posted id when database-error storno fails', async () => {
    const { supabase, inserts } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          cash_account_id: null,
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': {
        data: null,
        error: { message: 'connection reset', code: '08006' },
      },
      'rpc:compensate_transaction_categorization': {
        data: null,
        error: { message: 'period locked' },
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )
    const body = await res.json()

    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details).toMatchObject({
      operation: 'attach_transaction_categorization',
      partial_posted_ids: { journal_entry_id: 'je-fresh' },
    })
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })
})
