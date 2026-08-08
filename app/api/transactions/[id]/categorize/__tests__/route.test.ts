import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import {
  JournalEntryNotBalancedError,
  PostCommitReadbackError,
} from '@/lib/bookkeeping/errors'

const { supabase: mockSupabase, enqueue, reset, calls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockBuildMappingResultFromCategory = vi.fn()
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) =>
    mockBuildMappingResultFromCategory(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) =>
    mockCreateTransactionJournalEntry(...args),
}))

// Booking-time duplicate guard: mocked to "no duplicate" by default so these
// tests exercise categorization, not the guard. The detection query is
// unit-tested in lib/transactions/__tests__/booking-duplicate-detection.test.ts.
const mockDetectDup = vi.fn()
// Spread the real module so pure helpers the route also imports from here
// (resolveTransactionAmountSek) keep their real behaviour; only the DB-backed
// detector is stubbed. A bare factory would leave those exports undefined.
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

// Behandlingshistorik append: mocked so we can assert the dismissal is
// persisted without reaching the service-role client.
const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

const mockSaveUserMappingRule = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  saveUserMappingRule: (...args: unknown[]) => mockSaveUserMappingRule(...args),
  // Mirror the real implementation: the transaction direction identifies the
  // semantic settlement side, independent of the account previously stored.
  applySettlementAccount: (
    result: { debit_account?: string; credit_account?: string },
    bankAccount: string,
    transactionAmount: number,
  ) =>
    transactionAmount < 0
      ? { ...result, credit_account: bankAccount }
      : { ...result, debit_account: bankAccount },
}))

const mockUpsertCounterpartyTemplate = vi.fn()
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: (...args: unknown[]) => mockUpsertCounterpartyTemplate(...args),
}))

const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

const mockResolveSettlementAccount = vi.fn()
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))

const mockFindMissingActiveAccounts = vi.fn()
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return {
    ...actual,
    findUnresolvableAccounts: (...args: unknown[]) => mockFindMissingActiveAccounts(...args),
  }
})

import { POST } from '../route'

describe('POST /api/transactions/[id]/categorize', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const defaultMappingResult = {
    rule: null,
    debit_account: '6200',
    credit_account: '1930',
    risk_level: 'NONE',
    confidence: 1,
    requires_review: false,
    default_private: false,
    vat_lines: [{ account_number: '2641', debit_amount: 62.5, credit_amount: 0, description: 'Ingående moms' }],
    description: 'Test expense',
  }

  const compensationSuccess = {
    status: 'reversed',
    original_journal_entry_id: 'je-1',
    reversal_journal_entry_ids: ['je-storno'],
    original_pointer_cleared: true,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockBuildMappingResultFromCategory.mockReturnValue(defaultMappingResult)
    // Default: every mapped account exists and is active. Tests covering the
    // missing-account path override this per-case.
    mockFindMissingActiveAccounts.mockResolvedValue([])
    // Default: no booking-time duplicate. The dedicated guard test overrides this.
    mockDetectDup.mockResolvedValue(null)
    mockAppendProcessingHistory.mockResolvedValue('evt-1')
    mockReverseEntry.mockResolvedValue({ id: 'je-storno' })
    mockResolveSettlementAccount.mockResolvedValue('1930')
  })

  it('returns a typed database error and creates no voucher when company settings cannot be read', async () => {
    enqueue({
      data: makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null }),
      error: null,
    })
    enqueue({ data: null, error: { message: 'permission denied', code: '42501' } })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: false },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { operation?: string } }
    }>(response)

    expect(status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { operation: 'fetch_company_settings' },
    })
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('stornoes a CAS-race orphan and returns no partial marker when compensation succeeds', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [{ id: 'period-1' }], error: null }) // ensureFiscalPeriod

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)

    // Lost the CAS: another request stamped journal_entry_id first.
    enqueue({ data: false, error: null })
    enqueue({ data: compensationSuccess, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBe(409)
    expect((body.error as { code: string }).code).toBe('TX_CATEGORIZE_RACE')

    expect((body.error as { details?: unknown }).details).toBeUndefined()
    expect(mockReverseEntry).not.toHaveBeenCalled()
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      expect.objectContaining({ p_original_journal_entry_id: 'je-1' }),
    )
  })

  it('compensates a readback-unverified posting and discloses its durable id', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })
    enqueue({ data: tx, error: null })
    enqueue({
      data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 },
      error: null,
    })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    const readbackError = new PostCommitReadbackError('je-readback', 42, 'timeout')
    mockCreateTransactionJournalEntry.mockRejectedValueOnce(readbackError)
    enqueue({ data: null, error: { message: 'compensation timeout' } })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: false },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        details: {
          operation: string
          journal_entry_id: string
          voucher_number: number
          partial_posted_ids: Record<string, string>
        }
      }
    }>(response)

    expect(status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: {
        operation: 'commit_entry.readback',
        journal_entry_id: 'je-readback',
        voucher_number: 42,
        partial_posted_ids: { journal_entry_id: 'je-readback' },
      },
    })
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      expect.objectContaining({ p_original_journal_entry_id: 'je-readback' }),
    )
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.anything(),
    )
  })

  it('does not mutate documents or inbox state when atomic attachment conflicts', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      document_id: 'doc-transaction',
      receipt_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: false, error: null }) // atomic attachment conflict
    enqueue({ data: compensationSuccess, error: null }) // atomic compensation

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: {
          is_business: true,
          category: 'expense_software',
          inbox_item_id: '11111111-1111-4111-8111-111111111111',
        },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(409)
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
    expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_inbox_items')
  })

  it('persists no dismissal or learning side effects when forced categorization fails attachment', async () => {
    const siblingId = '660e8400-e29b-41d4-a716-446655440111'
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })
    mockDetectDup.mockResolvedValue({
      transaction_id: siblingId,
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: null,
      amount: -500,
      currency: 'SEK',
      amount_in_currency: -500,
      amount_verified: true,
      unverified_reason: null,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: false, error: null })
    enqueue({ data: compensationSuccess, error: null })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: {
          is_business: true,
          category: 'expense_software',
          force: true,
          expected_duplicate_transaction_id: siblingId,
        },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )

    expect(response.status).toBe(409)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
    expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
    expect(mockUpsertCounterpartyTemplate).not.toHaveBeenCalled()
  })

  it('uses exact company-scoped cash-account and ledger provenance', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      cash_account_id: 'cash-revolut-sek',
    })
    mockResolveSettlementAccount.mockResolvedValueOnce('1931')
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))

    expect(response.status).toBe(200)
    expect(mockResolveSettlementAccount).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'cash-revolut-sek',
      expect.anything(),
    )
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.objectContaining({ credit_account: '1931' }),
      undefined,
      { category: 'expense_software', isBusiness: true },
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_expected_cash_account_id: 'cash-revolut-sek',
        p_expected_settlement_account: '1931',
        p_expected_journal_entry_id: null,
        p_journal_entry_id: 'je-1',
      }),
    )
  })

  it('surfaces the posted id when CAS-race storno fails', async () => {
    const tx = makeTransaction({ id: 'tx-1', journal_entry_id: null })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: false, error: null })
    enqueue({ data: null, error: { message: 'period locked' } })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: unknown }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(body.error.details).toEqual({
      partial_posted_ids: { journal_entry_id: 'je-1' },
    })
    expect(mockSupabase.from).not.toHaveBeenCalledWith('voucher_gap_explanations')
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns an exact already-posted categorization as a no-write idempotent success', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: 'je-existing',
      category: 'expense_software',
      is_business: true,
    })
    enqueue({ data: tx, error: null })
    enqueue({
      data: {
        id: 'je-existing',
        company_id: 'company-1',
        status: 'posted',
        source_type: 'bank_transaction',
        source_id: 'tx-1',
        categorization_category: 'expense_software',
        categorization_is_business: true,
      },
      error: null,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      already_had_journal_entry: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.already_had_journal_entry).toBe(true)
    expect(body.journal_entry_id).toBe('je-existing')
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'requested category change',
      txCategory: 'expense_office',
      txBusiness: true,
      request: { is_business: true, category: 'expense_software' },
      journalCategory: 'expense_office',
      journalBusiness: true,
      expectedReason: 'requested_change',
    },
    {
      name: 'requested business/private change',
      txCategory: 'expense_office',
      txBusiness: true,
      request: { is_business: false },
      journalCategory: 'expense_office',
      journalBusiness: true,
      expectedReason: 'requested_change',
    },
    {
      name: 'preexisting transaction-voucher drift',
      txCategory: 'expense_software',
      txBusiness: true,
      request: { is_business: true, category: 'expense_software' },
      journalCategory: 'expense_office',
      journalBusiness: true,
      expectedReason: 'transaction_metadata_drift',
    },
    {
      name: 'legacy null journal metadata',
      txCategory: 'expense_office',
      txBusiness: true,
      request: { is_business: true, category: 'expense_office' },
      journalCategory: null,
      journalBusiness: null,
      expectedReason: 'metadata_unprovable',
    },
  ])('fails closed for $name without updating the transaction', async (testCase) => {
    enqueue({
      data: makeTransaction({
        id: 'tx-1',
        company_id: 'company-1',
        journal_entry_id: 'je-existing',
        category: testCase.txCategory as never,
        is_business: testCase.txBusiness,
      }),
      error: null,
    })
    enqueue({
      data: {
        id: 'je-existing',
        company_id: 'company-1',
        status: 'posted',
        source_type: 'bank_transaction',
        source_id: 'tx-1',
        categorization_category: testCase.journalCategory,
        categorization_is_business: testCase.journalBusiness,
      },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: testCase.request,
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: { reason: testCase.expectedReason },
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
  })

  it('fails closed when posted journal metadata cannot be queried', async () => {
    enqueue({
      data: makeTransaction({
        id: 'tx-1',
        company_id: 'company-1',
        journal_entry_id: 'je-existing',
        category: 'expense_office',
        is_business: true,
      }),
      error: null,
    })
    enqueue({ data: null, error: { message: 'read timeout' } })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: true, category: 'expense_office' },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { operation?: string } }
    }>(response)

    expect(status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: { operation: 'verify_existing_transaction_categorization' },
    })
    expect(calls).not.toContainEqual(
      expect.objectContaining({ table: 'transactions', method: 'update' }),
    )
  })

  it('fails closed when the transaction pointer has no company-scoped journal row', async () => {
    enqueue({
      data: makeTransaction({
        id: 'tx-1',
        company_id: 'company-1',
        journal_entry_id: 'je-missing',
        category: 'expense_office',
        is_business: true,
      }),
      error: null,
    })
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: true, category: 'expense_office' },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: { reason: 'journal_missing' },
    })
  })

  it('rejects mapping-affecting input on an existing journal before any metadata write', async () => {
    enqueue({
      data: makeTransaction({
        id: 'tx-1',
        company_id: 'company-1',
        journal_entry_id: 'je-existing',
        category: 'expense_office',
        is_business: true,
      }),
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: {
          is_business: true,
          category: 'expense_office',
          account_override: '6250',
        },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string; fields?: string[] } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: {
        reason: 'mapping_affecting_change',
        fields: ['account_override'],
      },
    })
    expect(mockSupabase.from).not.toHaveBeenCalledWith('journal_entries')
  })

  it.each([
    { company_id: 'company-other', source_type: 'bank_transaction', source_id: 'tx-1' },
    { company_id: 'company-1', source_type: 'manual', source_id: 'tx-1' },
    { company_id: 'company-1', source_type: 'bank_transaction', source_id: 'tx-other' },
    { company_id: 'company-1', source_type: 'bank_transaction', source_id: 'tx-1', status: 'reversed' },
  ])('rejects wrong-company/source/status posted metadata %#', async (journalOverride) => {
    enqueue({
      data: makeTransaction({
        id: 'tx-1',
        company_id: 'company-1',
        journal_entry_id: 'je-existing',
        category: 'expense_office',
        is_business: true,
      }),
      error: null,
    })
    enqueue({
      data: {
        id: 'je-existing',
        company_id: 'company-1',
        status: 'posted',
        source_type: 'bank_transaction',
        source_id: 'tx-1',
        categorization_category: 'expense_office',
        categorization_is_business: true,
        ...journalOverride,
      },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: true, category: 'expense_office' },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error).toMatchObject({
      code: 'TX_CATEGORIZE_RACE',
      details: { reason: 'journal_identity_mismatch' },
    })
  })

  it('creates journal entry for business expense', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch company settings
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // ensureFiscalPeriod: check existing
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)

    // Update transaction (CAS guard: returns matched row)
    enqueue({ data: true, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_id: string
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
    expect(body.category).toBe('expense_software')
    expect(mockSaveUserMappingRule).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'GitHub',
      '6200',
      '1930',
      false,
      undefined,
      undefined
    )
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transaction.categorized' })
    )
  })

  it('passes body.dimensions onto the mapping result the engine books', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })
    // Fresh copy: the route mutates the mapping result in place, and the
    // shared defaultMappingResult object would leak dimensions across tests.
    mockBuildMappingResultFromCategory.mockReturnValue({ ...defaultMappingResult })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [{ id: 'period-1' }], error: null }) // fiscal period check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null }) // atomic attachment matched

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        dimensions: { '1': 'KS1', '6': 'P001' },
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.objectContaining({ dimensions: { '1': 'KS1', '6': 'P001' } }),
      undefined,
      { category: 'expense_software', isBusiness: true },
    )
  })

  it('rejects a malformed dimensions bag with 400', async () => {
    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        // Key must be a SIE dim number: 'projekt' is not.
        dimensions: { projekt: 'P001' },
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('flags an inbox underlag matched to the transaction as booked', async () => {
    // A document was attached to this transaction in the inbox
    // (matched_transaction_id) but not booked from there. Booking the
    // transaction here (no inbox_item_id in the body) must still stamp the
    // matched inbox item with the new journal entry and link its document.
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      document_id: null, // ensure document_attachments is touched ONLY by the inbox propagation
    })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [{ id: 'period-1' }], error: null }) // fiscal period check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null }) // atomic attachment matched
    // Inbox propagation: one matched item with a document
    enqueue({ data: [{ id: 'inbox-1', document_id: 'doc-1' }], error: null })
    enqueue({ data: null, error: null }) // document_attachments update
    enqueue({ data: null, error: null }) // invoice_inbox_items update

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
    // The propagation looked up matched inbox items and linked the document.
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('does not touch the inbox when no underlag is matched to the transaction', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      document_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null }) // atomic attachment
    enqueue({ data: [], error: null }) // inbox propagation: no matched items

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // No matched underlag → no document/inbox writes from the propagation.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  it('fails without attaching categorization when journal entry creation fails', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'Test',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockRejectedValue(new Error('Period locked'))

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        details: { operation: string; reason: string }
      }
    }>(response)

    expect(status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      details: {
        operation: 'create_transaction_journal_entry',
        reason: 'Kunde inte hantera transaktionen. Försök igen.',
      },
    })
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.anything(),
    )
  })

  it('translates typed engine errors without attaching a null journal id', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'Test',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockRejectedValue(new JournalEntryNotBalancedError(100, 80))

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        details: { operation: string; reason: string }
      }
    }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details.operation).toBe('create_transaction_journal_entry')
    expect(body.error.details.reason).toContain('balanserar inte')
    expect(body.error.details.reason).toMatch(/100/)
    expect(body.error.details.reason).toMatch(/80/)
    expect(body.error.details.reason).not.toContain('not balanced')
    expect(body.error.details.reason).not.toContain('check constraint')
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith(
      'attach_transaction_categorization',
      expect.anything(),
    )
  })

  it('returns 500 when transaction update fails', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Transaction update fails
    enqueue({ data: null, error: { message: 'Update failed' } })
    enqueue({ data: compensationSuccess, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: Record<string, unknown> }
    }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details).not.toHaveProperty('partial_posted_ids')
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('surfaces the posted id when attachment-update error storno fails', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: null, error: { message: 'Update failed' } })
    enqueue({ data: null, error: { message: 'period locked' } })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: unknown }
    }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details).toMatchObject({
      partial_posted_ids: { journal_entry_id: 'je-1' },
    })
    expect(mockSupabase.from).not.toHaveBeenCalledWith('voucher_gap_explanations')
  })

  it('returns 400 when mapping result has empty debit_account', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '',
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_INVALID_MAPPING')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 409 TX_CATEGORIZE_SUGGEST_SI_MATCH when 2440 mapping matches an open supplier invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // Prong B: supplier lookup
    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // Open supplier invoices candidate query
    enqueue({
      data: [
        {
          id: 'si-1',
          supplier_invoice_number: 'INV-2026-0042',
          invoice_date: '2026-05-01',
          remaining_amount: 10000,
          currency: 'SEK',
          supplier: { name: 'Leverantör AB' },
        },
      ],
      error: null,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { candidates: unknown[] } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('proceeds with 2440 categorization when confirm_no_match=true', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // No supplier/invoice lookups happen because confirm_no_match=true skips the block
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('does not trigger SI suggestion when 2440 has no matching open supplier invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // Supplier lookup returns a supplier
    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // No open invoices in the amount window
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_created: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
  })

  // ── Suggestion-guard currency. `transactions.amount` is denominated in
  // `transactions.currency`; `remaining_amount` is denominated in the invoice's
  // currency. A plus-minus 2 % band around a EUR bank row applied to a kronor
  // `remaining_amount` column is off by the whole exchange rate.
  const eurExpenseTx = (over: Record<string, unknown> = {}) =>
    makeTransaction({
      id: 'tx-1',
      amount: -1000,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
      ...over,
    })

  const sekSupplierInvoice = (remaining: number) => ({
    id: 'si-1',
    supplier_invoice_number: 'INV-2026-0042',
    invoice_date: '2026-05-01',
    remaining_amount: remaining,
    total: remaining,
    currency: 'SEK',
    total_sek: remaining,
    exchange_rate: null,
    supplier: { name: 'Leverantör AB' },
  })

  it('EUR transaction: a 1 000 SEK supplier invoice is not suggested for a 1 000 EUR payment', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // First sweep returns the same-magnitude kronor invoice the old EUR band
    // selected; the shared-unit re-check must drop it.
    enqueue({ data: [sekSupplierInvoice(1000)], error: null })
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod + transaction update
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
  })

  it('EUR transaction with a rate: the 11 500 SEK supplier invoice IS suggested', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // EUR sweep finds nothing; the kronor sweep finds the invoice at the
    // converted magnitude.
    enqueue({ data: [], error: null })
    enqueue({ data: [sekSupplierInvoice(11500)], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ supplier_invoice_id: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates.map((c) => c.supplier_invoice_id)).toEqual(['si-1'])
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('EUR transaction without a rate: kronor invoices are excluded, never compared raw', async () => {
    enqueue({ data: eurExpenseTx({ exchange_rate: null }), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // Only the EUR sweep is planned; the kronor invoice it returns here has no
    // shared unit with the bank row and must be dropped.
    enqueue({ data: [sekSupplierInvoice(1000)], error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('EUR transaction: a 1 000 EUR supplier invoice still matches in its own currency', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    enqueue({
      data: [
        {
          ...sekSupplierInvoice(1000),
          currency: 'EUR',
          total_sek: 11500,
          exchange_rate: 11.5,
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
  })

  it('EUR inbound transaction: a 1 000 SEK customer invoice is not suggested', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // Customer lookups (merchant_name, description)
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // EUR sweep returns the same-magnitude kronor invoice; kronor sweep empty.
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          remaining_amount: 1000,
          total: 1000,
          currency: 'SEK',
          total_sek: 1000,
          exchange_rate: null,
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod + transaction update
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('EUR inbound transaction with a rate: the 11 500 SEK customer invoice IS suggested', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      currency: 'EUR',
      amount_sek: 11500,
      exchange_rate: null,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    enqueue({ data: [{ id: 'cust-1' }], error: null })
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // EUR sweep empty; kronor sweep finds the invoice at the converted amount.
    enqueue({ data: [], error: null })
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          remaining_amount: 11500,
          total: 11500,
          currency: 'SEK',
          total_sek: 11500,
          exchange_rate: null,
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ invoice_id: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates.map((c) => c.invoice_id)).toEqual(['inv-1'])
  })

  it('returns 409 TX_CATEGORIZE_SUGGEST_CI_MATCH when 1930/1510 mapping matches an open customer invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // Customer lookup pass 1 (merchant_name): one match
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // Customer lookup pass 2 (description)
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // Open invoices by customer
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          remaining_amount: 12500,
          total: 12500,
          currency: 'SEK',
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })
    // OCR pass: tx.reference is null so the route still runs the OCR query
    // with a no-op result. Provide an empty data set so the chain resolves.
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ invoice_id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(body.error.details.candidates[0].invoice_id).toBe('inv-1')
    expect(body.error.details.candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('proceeds with 1930/1510 categorization when confirm_no_match=true (customer side)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // No customer/invoice lookups: confirm_no_match=true skips the block.
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('warns (409) and books nothing when a booked sibling shares date+amount', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    enqueue({ data: tx, error: null }) // fetch: guard runs right after, before any booking work

    mockDetectDup.mockResolvedValue({
      transaction_id: '660e8400-e29b-41d4-a716-446655440111',
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: 'redan bokförd',
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidate: { voucher_label: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate.voucher_label).toBe('A142')
    // The duplicate guard fires before any verifikat is created.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // Blocking a duplicate is not a dismissal: nothing is logged.
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('persists a behandlingshistorik event when force=true dismisses a duplicate', async () => {
    const SIBLING_UUID = '660e8400-e29b-41d4-a716-446655440111'
    const tx = makeTransaction({ id: 'tx-1', amount: -500, merchant_name: 'GitHub', journal_entry_id: null })

    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [{ id: 'period-1' }], error: null }) // ensureFiscalPeriod existing check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)
    enqueue({ data: true, error: null }) // atomic attachment matched

    mockDetectDup.mockResolvedValue({
      transaction_id: SIBLING_UUID,
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: null,
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        force: true,
        expected_duplicate_transaction_id: SIBLING_UUID,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_created: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    // The dismissal is recorded to behandlingshistorik (BFNAR 2013:2 kap 8).
    expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        aggregateType: 'BankTransaction',
        aggregateId: 'tx-1',
        actor: { type: 'user', id: 'user-1' },
        payload: expect.objectContaining({ dismissed_transaction_id: SIBLING_UUID }),
      }),
    )
    const attachmentOrder = mockSupabase.rpc.mock.invocationCallOrder[0]
    expect(attachmentOrder).toBeLessThan(mockAppendProcessingHistory.mock.invocationCallOrder[0])
    expect(attachmentOrder).toBeLessThan(mockSaveUserMappingRule.mock.invocationCallOrder[0])
    expect(attachmentOrder).toBeLessThan(mockUpsertCounterpartyTemplate.mock.invocationCallOrder[0])
  })

  it('categorizes as private when is_business is false', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update transaction (CAS guard: returns matched row)
    enqueue({ data: true, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: false },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body.category).toBe('private')
    // Should NOT save mapping rule for private transactions
    expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when the mapped debit account is not active in the chart', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch company settings
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    // Mapping built from category, but the debit account is missing/inactive
    // in this company's kontoplan. findMissingActiveAccounts is mocked at the
    // module level; flag the debit account here to simulate the same outcome
    // the engine would otherwise hit at AccountsNotInChartError.
    mockFindMissingActiveAccounts.mockResolvedValueOnce(['6200'])

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[]; message: string }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['6200'])
    expect(body.error.message).toMatch(/Följande konton behöver aktiveras/)
    // Engine must NOT be called once validation flagged a missing account.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // No save of mapping rule either: the categorization didn't go through.
    expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART listing every missing/inactive account', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -1000,
      merchant_name: 'Acme',
      journal_entry_id: null,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

    // Multiple accounts missing: covers the common "imported a template with
    // accounts that this kontoplan never enabled" case.
    mockFindMissingActiveAccounts.mockResolvedValueOnce(['5410', '2641'])

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_office' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[]; message: string }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    // AccountsNotInChartError sorts + dedupes its input.
    expect(body.error.account_numbers).toEqual(['2641', '5410'])
    expect(body.error.message).toContain('2641')
    expect(body.error.message).toContain('5410')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when the engine throws AccountsNotInChartError (defense in depth)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // ensureFiscalPeriod existing-period check
    enqueue({ data: [{ id: 'period-1' }], error: null })

    // Pre-validation says everything is fine: simulates a race where an
    // account got deactivated between our chart_of_accounts read and the
    // engine's resolveAccountIds read. The engine throws and the route must
    // surface a structured 400 rather than the partial-success path that
    // would have marked the row bokförd with no verifikation.
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    mockCreateTransactionJournalEntry.mockRejectedValue(
      new AccountsNotInChartError(['6200']),
    )

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[] }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['6200'])
    // Transaction update must NOT have run: if it had, the test would have
    // had to enqueue a response for it. The absence of an enqueue here plus
    // the 400 status is the assertion that the route did not fall through.
  })

  // The transactions page surfaces TX_CATEGORIZE_INVALID_ACCOUNT with an
  // inline "Aktivera och bokför" toast and reads details.accountNumber to
  // call POST /accounts/activate. This test pins the error shape that flow
  // depends on: if the field name changes the recovery UI silently breaks.
  it('returns 400 TX_CATEGORIZE_INVALID_ACCOUNT with details.accountNumber when account_override is not in the chart', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -869.25,
      merchant_name: 'Paddle',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // chart_of_accounts lookup for '5420': not in the company's chart.
    // Using a plain expense account (Programvaror) avoids the implication
    // that 4535 (Inköp av varor från annat EU-land, reverse-charge) would
    // be a valid override on a domestic transaction without its paired
    // moms legs (2614/2645): see the Swedish compliance review note.
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software', account_override: '5420' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { accountNumber?: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_INVALID_ACCOUNT')
    expect(body.error.details.accountNumber).toBe('5420')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })
})
