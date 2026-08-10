/**
 * Integration tests for POST /api/v1/companies/{companyId}/transactions/batch-categorize.
 *
 * Covers the missing-account guard: when a categorization references an
 * account that isn't active in the company's kontoplan, the per-item result
 * must surface as ACCOUNTS_NOT_IN_CHART without ever marking the row bokförd.
 * Other items in the same batch continue independently (partial-success
 * semantics).
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
  resolveSettlementAccountMock,
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
  // Default: every mapped account resolves (active, or seedable standard
  // BAS). Per-test overrides simulate the bug surface (inactive/unknown).
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
  reverseEntryMock: vi.fn().mockResolvedValue(undefined),
  resolveSettlementAccountMock: vi.fn().mockResolvedValue('1931'),
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
  return {
    ...actual,
    findUnresolvableAccounts: findMissingAccountsMock,
  }
})
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: resolveSettlementAccountMock,
}))
// category mapping is real: gives the route real BAS accounts to validate.

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
  // phantom column, so assertions have to inspect the object itself.
  const inserts: Record<string, unknown[]> = {}
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
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
          calls.push({ table, method: String(prop), args })
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
  return { supabase, inserts, calls }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const compensationSuccess = {
  data: {
    status: 'reversed',
    original_journal_entry_id: 'je-fresh',
    reversal_journal_entry_ids: ['je-storno'],
    original_pointer_cleared: true,
  },
  error: null,
}

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}
function batchParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  findMissingAccountsMock.mockResolvedValue([])
  reverseEntryMock.mockResolvedValue(undefined)
  resolveSettlementAccountMock.mockResolvedValue('1931')
  createTxJE.mockResolvedValue({ id: 'je-fresh' })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST batch-categorize', () => {
  it('emits the authoritative post-attachment transaction state', async () => {
    const before = {
      id: TX_A,
      company_id: COMPANY_ID,
      user_id: 'user-1',
      date: '2026-05-12',
      amount: -349.5,
      currency: 'SEK',
      merchant_name: 'ICA',
      description: 'Office supplies',
      reference: 'CARD-123',
      journal_entry_id: null,
      cash_account_id: 'cash-revolut-sek',
      category: null,
      is_business: null,
    }
    const after = {
      ...before,
      journal_entry_id: 'je-fresh',
      category: 'expense_office',
      is_business: true,
      updated_at: '2026-08-09T12:00:00.000Z',
    }
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: [
        { data: before, error: null },
        { data: after, error: null },
      ],
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: true, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.data.results[0].ok).toBe(true)
    expect(emitSpy).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'transaction.categorized',
      payload: expect.objectContaining({
        transaction: after,
        userId: 'user-1',
        companyId: COMPANY_ID,
      }),
    })
  })

  it.each([
    {
      name: 'readback query failure',
      readback: { data: null, error: { message: 'connection reset', code: '08006' } },
      expectedCode: 'BOOKKEEPING_DATABASE_ERROR',
    },
    {
      name: 'unverifiable stale readback',
      readback: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          journal_entry_id: null,
          cash_account_id: 'cash-revolut-sek',
          category: null,
          is_business: null,
        },
        error: null,
      },
      expectedCode: 'TX_CATEGORIZE_RACE',
    },
  ])('emits no event and compensates after $name', async ({ readback, expectedCode }) => {
    const before = {
      id: TX_A,
      company_id: COMPANY_ID,
      date: '2026-05-12',
      amount: -349.5,
      currency: 'SEK',
      merchant_name: 'ICA',
      journal_entry_id: null,
      cash_account_id: 'cash-revolut-sek',
    }
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: [
        { data: before, error: null },
        readback,
      ],
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: true, error: null },
      'rpc:compensate_transaction_categorization': compensationSuccess,
    })
    mockServiceClient.mockReturnValue(supabase)
    const emitSpy = vi.spyOn(eventBus, 'emit')

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(body.data.results[0]).toMatchObject({
      ok: false,
      error: { code: expectedCode },
    })
    expect(emitSpy).not.toHaveBeenCalled()
    expect(supabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      expect.objectContaining({ p_original_journal_entry_id: 'je-fresh' }),
    )
  })

  it('compensates a readback-unverified posting and discloses its durable id', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -125,
          currency: 'SEK',
          journal_entry_id: null,
          cash_account_id: 'cash-1931',
        },
        error: null,
      },
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

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{
            transaction_id: TX_A,
            categorization: { is_business: false },
          }],
        },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        details: {
          operation: 'commit_entry.readback',
          journal_entry_id: 'je-readback',
          voucher_number: 42,
          partial_posted_ids: { journal_entry_id: 'je-readback' },
        },
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

  it.each([
    {
      name: 'account override',
      categorization: {
        is_business: true,
        category: 'expense_office',
        account_override: '6250',
      },
      expectedField: 'account_override',
    },
    {
      name: 'counterparty template',
      categorization: {
        is_business: true,
        counterparty_template_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      expectedField: 'counterparty_template_id',
    },
    {
      name: 'booking template',
      categorization: {
        is_business: true,
        template_id: 'expense-office',
      },
      expectedField: 'template_id',
    },
    {
      name: 'VAT treatment',
      categorization: {
        is_business: true,
        category: 'expense_office',
        vat_treatment: 'standard_25',
      },
      expectedField: 'vat_treatment',
    },
    {
      name: 'dimensions',
      categorization: {
        is_business: true,
        category: 'expense_office',
        dimensions: { '1': 'KS01' },
      },
      expectedField: 'dimensions',
    },
  ])('fails closed for $name on an already-posted transaction', async (testCase) => {
    const { supabase, calls } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -125,
          currency: 'SEK',
          merchant_name: 'Fixture',
          journal_entry_id: 'je-posted',
          cash_account_id: 'cash-1931',
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: testCase.categorization }] },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.data.results[0]).toMatchObject({
      ok: false,
      error: {
        code: 'TX_CATEGORIZE_ALREADY_POSTED_MAPPING_CHANGE',
        details: { fields: [testCase.expectedField] },
      },
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
    expect(createTxJE).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'returns exact posted metadata as a no-write idempotent success (dry_run=%s)',
    async (dryRun) => {
    const { supabase, calls } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -125,
          currency: 'SEK',
          merchant_name: 'Fixture',
          journal_entry_id: 'je-posted',
          cash_account_id: 'cash-1931',
          category: 'private',
          is_business: false,
        },
        error: null,
      },
      journal_entries: {
        data: {
          id: 'je-posted',
          company_id: COMPANY_ID,
          status: 'posted',
          source_type: 'bank_transaction',
          source_id: TX_A,
          categorization_category: 'private',
          categorization_is_business: false,
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize${dryRun ? '?dry_run=true' : ''}`,
        {
          items: [{
            transaction_id: TX_A,
            categorization: { is_business: false },
          }],
        },
      ),
      batchParams(),
    )
    const body = await res.json()
    const item = dryRun ? body.data.preview.results[0] : body.data.results[0]

    expect(item).toMatchObject({
      ok: true,
      data: {
        journal_entry_created: false,
        journal_entry_id: 'je-posted',
        category: 'private',
        already_had_journal_entry: true,
      },
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
    expect(createTxJE).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
    },
  )

  it.each([
    { dryRun: false, reason: 'transaction_metadata_drift', txCategory: 'expense_software', journalCategory: 'expense_office', journalBusiness: true, sourceType: 'bank_transaction' },
    { dryRun: true, reason: 'transaction_metadata_drift', txCategory: 'expense_software', journalCategory: 'expense_office', journalBusiness: true, sourceType: 'bank_transaction' },
    { dryRun: false, reason: 'metadata_unprovable', txCategory: 'expense_office', journalCategory: null, journalBusiness: null, sourceType: 'bank_transaction' },
    { dryRun: true, reason: 'metadata_unprovable', txCategory: 'expense_office', journalCategory: null, journalBusiness: null, sourceType: 'bank_transaction' },
    { dryRun: false, reason: 'journal_identity_mismatch', txCategory: 'expense_office', journalCategory: 'expense_office', journalBusiness: true, sourceType: 'manual' },
    { dryRun: true, reason: 'journal_identity_mismatch', txCategory: 'expense_office', journalCategory: 'expense_office', journalBusiness: true, sourceType: 'manual' },
  ])('fails closed with dry/live parity for $reason (dry_run=$dryRun)', async (testCase) => {
    const { supabase, calls } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -125,
          currency: 'SEK',
          journal_entry_id: 'je-posted',
          cash_account_id: 'cash-1931',
          category: testCase.txCategory,
          is_business: true,
        },
        error: null,
      },
      journal_entries: {
        data: {
          id: 'je-posted',
          company_id: COMPANY_ID,
          status: 'posted',
          source_type: testCase.sourceType,
          source_id: TX_A,
          categorization_category: testCase.journalCategory,
          categorization_is_business: testCase.journalBusiness,
        },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize${testCase.dryRun ? '?dry_run=true' : ''}`,
        {
          items: [{
            transaction_id: TX_A,
            categorization: { is_business: true, category: 'expense_office' },
          }],
        },
      ),
      batchParams(),
    )
    const body = await res.json()
    const item = testCase.dryRun ? body.data.preview.results[0] : body.data.results[0]

    expect(item).toMatchObject({
      ok: false,
      error: {
        code: 'TX_CATEGORIZE_RACE',
        details: { reason: testCase.reason },
      },
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('fails the batch before posting when company settings cannot be read', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        company_settings: {
          data: null,
          error: { message: 'permission denied', code: '42501' },
        },
      }).supabase,
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{
            transaction_id: TX_A,
            categorization: { is_business: false },
          }],
        },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { operation: 'fetch_company_settings' },
    })
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('uses the transaction settlement account in both dry-run preview and live posting', async () => {
    const database = {
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
          cash_account_id: 'cash-revolut-sek',
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: true, error: null },
    }

    mockServiceClient.mockReturnValue(makeFlexibleSupabase(database).supabase)
    const dryRun = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize?dry_run=true`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    const dryRunBody = await dryRun.json()
    expect(dryRun.status, JSON.stringify(dryRunBody)).toBe(200)
    expect(dryRunBody).toHaveProperty('data.preview.results')
    expect(dryRunBody.data.preview.results[0].data.preview.credit_account).toBe('1931')
    expect(createTxJE).not.toHaveBeenCalled()

    mockServiceClient.mockReturnValue(makeFlexibleSupabase(database).supabase)
    const live = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    expect(live.status).toBe(200)
    expect(createTxJE).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: TX_A }),
      expect.objectContaining({ credit_account: '1931' }),
      undefined,
      { category: 'expense_office', isBusiness: true },
    )
  })

  it('applies counterparty templates and account overrides to the business leg for both directions and settlement accounts', async () => {
    const counterpartyTemplateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const cases = [
      {
        name: 'outgoing counterparty template on 1931',
        amount: -125,
        settlementAccount: '1931',
        categorization: { is_business: true, counterparty_template_id: counterpartyTemplateId },
        expectedCategory: 'uncategorized',
        extraDatabase: {
          categorization_templates: {
            data: {
              id: counterpartyTemplateId,
              company_id: COMPANY_ID,
              user_id: null,
              counterparty_name: 'Office Vendor',
              counterparty_aliases: ['Office Vendor'],
              debit_account: '5410',
              credit_account: '1930',
              vat_treatment: 'standard_25',
              vat_account: '2641',
              category: 'expense_office',
              line_pattern: null,
              occurrence_count: 3,
              confidence: 0.9,
              last_seen_date: '2026-05-01',
              source: 'user_approved',
              is_active: true,
            },
            error: null,
          },
        },
        expected: { debit_account: '5410', credit_account: '1931', vat_account: '2641' },
      },
      {
        name: 'incoming counterparty template on 1940',
        amount: 250,
        settlementAccount: '1940',
        categorization: { is_business: true, counterparty_template_id: counterpartyTemplateId },
        expectedCategory: 'uncategorized',
        extraDatabase: {
          categorization_templates: {
            data: {
              id: counterpartyTemplateId,
              company_id: COMPANY_ID,
              user_id: null,
              counterparty_name: 'Customer',
              counterparty_aliases: ['Customer'],
              debit_account: '1930',
              credit_account: '3041',
              vat_treatment: null,
              vat_account: null,
              category: 'income_sales',
              line_pattern: null,
              occurrence_count: 3,
              confidence: 0.9,
              last_seen_date: '2026-05-01',
              source: 'user_approved',
              is_active: true,
            },
            error: null,
          },
        },
        expected: { debit_account: '1940', credit_account: '3041' },
      },
      {
        name: 'outgoing account override on 1940',
        amount: -125,
        settlementAccount: '1940',
        categorization: { is_business: true, category: 'expense_office', account_override: '6250' },
        expectedCategory: 'expense_office',
        extraDatabase: {
          chart_of_accounts: {
            data: { account_number: '6250', account_class: 6 },
            error: null,
          },
        },
        expected: { debit_account: '6250', credit_account: '1940', vat_account: '2641' },
      },
      {
        name: 'incoming account override on 1931',
        amount: 250,
        settlementAccount: '1931',
        categorization: { is_business: true, category: 'income_services', account_override: '3051' },
        expectedCategory: 'income_services',
        extraDatabase: {
          chart_of_accounts: {
            data: { account_number: '3051', account_class: 3 },
            error: null,
          },
        },
        expected: { debit_account: '1931', credit_account: '3051', vat_account: '2611' },
      },
    ] as const

    for (const testCase of cases) {
      resolveSettlementAccountMock.mockResolvedValueOnce(testCase.settlementAccount)
      const database = {
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        transactions: [
          {
            data: {
              id: TX_A,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: testCase.amount,
              currency: 'SEK',
              merchant_name: 'Fixture',
              journal_entry_id: null,
              cash_account_id: `cash-${testCase.settlementAccount}`,
            },
            error: null,
          },
          {
            data: {
              id: TX_A,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: testCase.amount,
              currency: 'SEK',
              merchant_name: 'Fixture',
              journal_entry_id: 'je-fresh',
              cash_account_id: `cash-${testCase.settlementAccount}`,
              category: testCase.expectedCategory,
              is_business: true,
            },
            error: null,
          },
        ],
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
        'rpc:attach_transaction_categorization': { data: true, error: null },
        ...testCase.extraDatabase,
      }
      mockServiceClient.mockReturnValue(makeFlexibleSupabase(database).supabase)

      const res = await POST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize?dry_run=true`,
          { items: [{ transaction_id: TX_A, categorization: testCase.categorization }] },
        ),
        batchParams(),
      )
      const body = await res.json()
      const preview = body.data?.preview?.results?.[0]?.data?.preview

      expect(res.status, `${testCase.name}: ${JSON.stringify(body)}`).toBe(200)
      expect(preview, testCase.name).toMatchObject({
        debit_account: testCase.expected.debit_account,
        credit_account: testCase.expected.credit_account,
      })
      if ('vat_account' in testCase.expected) {
        expect(preview.vat_lines, testCase.name).toContainEqual(
          expect.objectContaining({ account_number: testCase.expected.vat_account }),
        )
      }

      resolveSettlementAccountMock.mockResolvedValueOnce(testCase.settlementAccount)
      mockServiceClient.mockReturnValue(makeFlexibleSupabase(database).supabase)
      const liveRes = await POST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
          { items: [{ transaction_id: TX_A, categorization: testCase.categorization }] },
        ),
        batchParams(),
      )
      const liveBody = await liveRes.json()

      expect(liveRes.status, `${testCase.name}: ${JSON.stringify(liveBody)}`).toBe(200)
      expect(liveBody.data.results[0].ok, testCase.name).toBe(true)
      expect(createTxJE).toHaveBeenLastCalledWith(
        expect.anything(),
        COMPANY_ID,
        'user-1',
        expect.objectContaining({ id: TX_A, amount: testCase.amount }),
        expect.objectContaining({
          debit_account: testCase.expected.debit_account,
          credit_account: testCase.expected.credit_account,
        }),
        undefined,
        { category: testCase.expectedCategory, isBusiness: true },
      )
    }
  })

  it('fails closed for missing, cross-company, failed, or unsupported public mapping inputs', async () => {
    const counterpartyTemplateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const cases = [
      {
        name: 'missing or cross-company counterparty template',
        categorization: { is_business: true, counterparty_template_id: counterpartyTemplateId },
        extraDatabase: { categorization_templates: { data: null, error: null } },
        expectedCode: 'NOT_FOUND',
      },
      {
        name: 'counterparty template lookup error',
        categorization: { is_business: true, counterparty_template_id: counterpartyTemplateId },
        extraDatabase: {
          categorization_templates: {
            data: null,
            error: { code: '42501', message: 'permission denied' },
          },
        },
        expectedCode: 'BOOKKEEPING_DATABASE_ERROR',
      },
      {
        name: 'inactive or missing account override',
        categorization: { is_business: true, category: 'expense_office', account_override: '6250' },
        extraDatabase: {
          chart_of_accounts: {
            data: null,
            error: { code: 'PGRST116', message: 'no rows' },
          },
        },
        expectedCode: 'TX_CATEGORIZE_INVALID_ACCOUNT',
      },
      {
        name: 'account override lookup error',
        categorization: { is_business: true, category: 'expense_office', account_override: '6250' },
        extraDatabase: {
          chart_of_accounts: {
            data: null,
            error: { code: '08006', message: 'connection failure' },
          },
        },
        expectedCode: 'BOOKKEEPING_DATABASE_ERROR',
      },
      {
        name: 'private categorization with counterparty template',
        categorization: { is_business: false, counterparty_template_id: counterpartyTemplateId },
        extraDatabase: {},
        expectedCode: 'VALIDATION_ERROR',
      },
      {
        name: 'account override combined with counterparty template',
        categorization: {
          is_business: true,
          counterparty_template_id: counterpartyTemplateId,
          account_override: '6250',
        },
        extraDatabase: {},
        expectedCode: 'VALIDATION_ERROR',
      },
    ] as const

    for (const testCase of cases) {
      const { supabase } = makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        transactions: {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -125,
            currency: 'SEK',
            merchant_name: 'Fixture',
            journal_entry_id: null,
            cash_account_id: 'cash-1931',
          },
          error: null,
        },
        ...testCase.extraDatabase,
      })
      mockServiceClient.mockReturnValue(supabase)

      const res = await POST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize?dry_run=true`,
          { items: [{ transaction_id: TX_A, categorization: testCase.categorization }] },
        ),
        batchParams(),
      )
      const body = await res.json()

      expect(res.status, testCase.name).toBe(200)
      expect(body.data.preview.results[0].error.code, testCase.name).toBe(testCase.expectedCode)
      expect(createTxJE, testCase.name).not.toHaveBeenCalled()
      expect(supabase.rpc, testCase.name).not.toHaveBeenCalled()
    }
  })

  it('isolates a settlement lookup failure to its item and continues the batch', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -100,
            currency: 'SEK',
            cash_account_id: 'cash-broken',
            journal_entry_id: null,
          },
          error: null,
        },
        {
          data: {
            id: TX_B,
            company_id: COMPANY_ID,
            date: '2026-05-13',
            amount: -200,
            currency: 'SEK',
            cash_account_id: 'cash-ok',
            journal_entry_id: null,
          },
          error: null,
        },
        {
          data: {
            id: TX_B,
            company_id: COMPANY_ID,
            date: '2026-05-13',
            amount: -200,
            currency: 'SEK',
            cash_account_id: 'cash-ok',
            journal_entry_id: 'je-fresh',
            category: 'expense_office',
            is_business: true,
          },
          error: null,
        },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: true, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    resolveSettlementAccountMock
      .mockRejectedValueOnce(new Error('temporary lookup failure'))
      .mockResolvedValueOnce('1931')

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0]).toMatchObject({
      ok: false,
      error: { code: 'BOOKKEEPING_DATABASE_ERROR' },
    })
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(createTxJE).toHaveBeenCalledTimes(1)
    expect(createTxJE).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: TX_B }),
      expect.objectContaining({ credit_account: '1931' }),
      undefined,
      { category: 'expense_office', isBusiness: true },
    )
  })

  it('returns per-item ACCOUNTS_NOT_IN_CHART for items whose mapping references inactive accounts; clean items still succeed', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // Each `transactions` lookup returns the same shape; the flexible
        // proxy serves both items from this single result. amount is < 0 so
        // both map to an expense flow.
        transactions: [
          {
            data: {
              id: TX_A,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -349.5,
              currency: 'SEK',
              merchant_name: 'ICA',
              journal_entry_id: null,
              cash_account_id: null,
            },
            error: null,
          },
          {
            data: {
              id: TX_B,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -349.5,
              currency: 'SEK',
              merchant_name: 'ICA',
              journal_entry_id: null,
              cash_account_id: null,
            },
            error: null,
          },
          {
            data: {
              id: TX_B,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -349.5,
              currency: 'SEK',
              merchant_name: 'ICA',
              journal_entry_id: 'je-fresh',
              cash_account_id: null,
              category: 'expense_office',
              is_business: true,
            },
            error: null,
          },
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
        'rpc:attach_transaction_categorization': { data: true, error: null },
      }).supabase,
    )

    // First item: mapping references an inactive account. Second item: clean.
    findMissingAccountsMock
      .mockResolvedValueOnce(['5410'])
      .mockResolvedValueOnce([])

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toHaveLength(2)
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].request_index).toBe(0)
    expect(body.data.results[0].error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.data.results[0].error.details.account_numbers).toEqual(['5410'])
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.results[1].request_index).toBe(1)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })

    // Engine must only be called for the clean item.
    expect(createTxJE).toHaveBeenCalledTimes(1)
  })

  it('returns ACCOUNTS_NOT_IN_CHART when the engine throws AccountsNotInChartError mid-flight (defense in depth)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
          },
          error: null,
        },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )
    // Pre-validation passes: race where an account got deactivated between
    // our chart_of_accounts read and the engine's resolveAccountIds read.
    findMissingAccountsMock.mockResolvedValueOnce([])
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    createTxJE.mockRejectedValueOnce(new AccountsNotInChartError(['5410']))

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toHaveLength(1)
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.data.results[0].error.details.account_numbers).toEqual(['5410'])
    expect(body.data.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
  })

  it('detects a cash-account change in the attachment CAS and reverses the orphan voucher', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
          cash_account_id: 'cash-revolut-sek',
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: false, error: null },
      'rpc:compensate_transaction_categorization': compensationSuccess,
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].error.code).toBe('TX_CATEGORIZE_RACE')
    expect(body.data.results[0].error.details).toBeUndefined()
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(supabase.rpc).toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.objectContaining({
        p_company_id: COMPANY_ID,
        p_transaction_id: TX_A,
        p_expected_cash_account_id: 'cash-revolut-sek',
        p_expected_settlement_account: '1931',
        p_expected_journal_entry_id: null,
        p_journal_entry_id: 'je-fresh',
      }),
    )
  })

  it('surfaces the posted voucher id and does not invent a voucher gap when CAS-race storno fails', async () => {
    const { supabase, inserts } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': { data: false, error: null },
      'rpc:compensate_transaction_categorization': {
        data: null,
        error: { message: 'period locked' },
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    // Storno fails: the orphan stays posted and still occupies its voucher
    // number, so expose its id for repair without inventing a number gap.

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: {
        partial_posted_ids: { journal_entry_id: 'je-fresh' },
      },
    })
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })

  it('returns an ordinary database failure after attachment-error storno succeeds', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
          cash_account_id: 'cash-revolut-sek',
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      'rpc:attach_transaction_categorization': {
        data: null,
        error: { message: 'connection reset', code: '08006' },
      },
      'rpc:compensate_transaction_categorization': compensationSuccess,
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(body.data.results[0].error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.data.results[0].error.details).toBeUndefined()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('exposes the posted id when attachment-error storno fails', async () => {
    const { supabase, inserts } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
          cash_account_id: 'cash-revolut-sek',
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
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }] },
      ),
      batchParams(),
    )
    const body = await res.json()

    expect(body.data.results[0].error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { partial_posted_ids: { journal_entry_id: 'je-fresh' } },
    })
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })
})
