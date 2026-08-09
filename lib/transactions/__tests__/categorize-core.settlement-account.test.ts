import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockDetectDuplicate = vi.fn()
const mockCreateJournalEntry = vi.fn()
const mockHasLiveLink = vi.fn()
const mockResolveSettlementAccount = vi.fn()
const mockAttachCategorizedTransaction = vi.fn()
const mockCompensatePostCommitReadbackFailure = vi.fn()
const mockAppendProcessingHistory = vi.fn()
const mockUpsertCounterpartyTemplate = vi.fn()

vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDuplicate(...args),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: (...args: unknown[]) => mockUpsertCounterpartyTemplate(...args),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn(),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: (...args: unknown[]) => mockHasLiveLink(...args),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))
vi.mock('@/lib/transactions/settlement-attachment', () => ({
  attachCategorizedTransaction: (...args: unknown[]) => mockAttachCategorizedTransaction(...args),
  compensatePostCommitReadbackFailure: (...args: unknown[]) =>
    mockCompensatePostCommitReadbackFailure(...args),
}))

import { categorizeMatchedTransaction } from '../categorize-core'
import { eventBus } from '@/lib/events/bus'
import { PostCommitReadbackError } from '@/lib/bookkeeping/errors'

function queuedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = vi.fn((table: string) => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(result)
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain
          }
        },
      },
    )
    return chain
  })
  return { from, __calls: calls } as never
}

const revolutFee = {
  id: 'tx-revolut-fee',
  date: '2026-08-02',
  amount: -150,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  description: 'Company Free plan fee',
  merchant_name: 'Revolut',
  cash_account_id: 'cash-revolut-sek',
  journal_entry_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDuplicate.mockResolvedValue(null)
  mockHasLiveLink.mockResolvedValue(false)
  mockResolveSettlementAccount.mockResolvedValue('1931')
  mockCreateJournalEntry.mockResolvedValue({ id: 'je-revolut-fee' })
  mockAttachCategorizedTransaction.mockResolvedValue({ ok: true })
  mockCompensatePostCommitReadbackFailure.mockResolvedValue({ handled: false })
  mockAppendProcessingHistory.mockResolvedValue('history-1')
  mockUpsertCounterpartyTemplate.mockResolvedValue(undefined)
})

describe('categorizeMatchedTransaction settlement account', () => {
  it('fails closed before posting when the company-settings query errors', async () => {
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: null, error: { message: 'RLS policy lookup failed', code: '42501' } },
    ])

    await expect(
      categorizeMatchedTransaction(
        supabase,
        'user-1',
        'company-1',
        revolutFee.id,
        { category: 'private' },
      ),
    ).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'fetch_company_settings',
    })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects approval when the staged settlement provenance has drifted', async () => {
    const supabase = queuedSupabase([{ data: revolutFee }])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      {
        category: 'expense_bank_fees',
        vatTreatment: 'exempt',
        expectedSettlement: {
          cashAccountId: 'cash-revolut-sek',
          ledgerAccount: '1930',
        },
      },
    )

    expect(result).toMatchObject({
      status: 409,
      errorCode: 'SETTLEMENT_ACCOUNT_DRIFT',
    })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('books an outgoing Revolut SEK transaction against 1931', async () => {
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
      { data: null },
      { data: [] },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      { category: 'expense_bank_fees', vatTreatment: 'exempt' },
    )

    expect(result.data?.journal_entry_id).toBe('je-revolut-fee')
    expect(mockResolveSettlementAccount).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'cash-revolut-sek',
      expect.anything(),
    )
    const mapping = mockCreateJournalEntry.mock.calls[0][4]
    expect(mapping.debit_account).toBe('6570')
    expect(mapping.credit_account).toBe('1931')
  })

  it('compensates and exposes a durable posted id when commit readback is unverifiable', async () => {
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
    ])
    const readbackError = new PostCommitReadbackError(
      'je-readback',
      42,
      'connection reset',
    )
    mockCreateJournalEntry.mockRejectedValueOnce(readbackError)
    mockCompensatePostCommitReadbackFailure.mockResolvedValueOnce({
      handled: true,
      journalEntryId: 'je-readback',
      voucherNumber: 42,
      compensationVerified: false,
      partialPostedIds: { journal_entry_id: 'je-readback' },
    })

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      { category: 'expense_bank_fees', vatTreatment: 'exempt' },
    )

    expect(result).toMatchObject({
      status: 500,
      errorCode: 'POST_COMMIT_READBACK_FAILED',
      partialPostedIds: { journal_entry_id: 'je-readback' },
    })
    expect(mockCompensatePostCommitReadbackFailure).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: revolutFee.id,
        error: readbackError,
      },
      expect.anything(),
    )
    expect(mockAttachCategorizedTransaction).not.toHaveBeenCalled()
  })

  it('never invokes categorization attachment when journal creation returns no id', async () => {
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
    ])
    mockCreateJournalEntry.mockResolvedValueOnce(null)

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      { category: 'expense_bank_fees', vatTreatment: 'exempt' },
    )

    expect(result).toMatchObject({
      status: 500,
      errorCode: 'BOOKKEEPING_DATABASE_ERROR',
    })
    expect(mockAttachCategorizedTransaction).not.toHaveBeenCalled()
  })

  it('CAS-attaches an approved voucher using company, cash-account, and journal provenance', async () => {
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
      { data: { id: revolutFee.id } },
      { data: [] },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      {
        category: 'expense_bank_fees',
        vatTreatment: 'exempt',
        expectedSettlement: {
          cashAccountId: 'cash-revolut-sek',
          ledgerAccount: '1931',
        },
      },
    )

    expect(result.data?.journal_entry_id).toBe('je-revolut-fee')
    expect(mockAttachCategorizedTransaction).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-revolut-fee',
        expectedJournalEntryId: null,
        expectedCashAccountId: 'cash-revolut-sek',
        expectedSettlementAccount: '1931',
        isBusiness: true,
        category: 'expense_bank_fees',
        journalEntryId: 'je-revolut-fee',
      },
      expect.anything(),
    )
  })

  it('stornoes the just-created voucher when the approval CAS loses a race', async () => {
    mockAttachCategorizedTransaction.mockResolvedValueOnce({
      ok: false,
      reason: 'conflict',
    })
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
      { data: null },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      {
        category: 'expense_bank_fees',
        vatTreatment: 'exempt',
        expectedSettlement: {
          cashAccountId: 'cash-revolut-sek',
          ledgerAccount: '1931',
        },
      },
    )

    expect(result).toMatchObject({ status: 409, errorCode: 'SETTLEMENT_ACCOUNT_DRIFT' })
    expect(result.partialPostedIds).toBeUndefined()
  })

  it('does not persist duplicate dismissal or learning when atomic attachment fails', async () => {
    mockDetectDuplicate.mockResolvedValueOnce({
      transaction_id: 'tx-existing',
      journal_entry_id: 'je-existing',
      voucher_label: 'A42',
      entry_date: '2026-08-02',
      description: 'Possible duplicate',
      amount: -150,
      currency: 'SEK',
      amount_in_currency: -150,
      amount_verified: true,
      unverified_reason: null,
    })
    mockAttachCategorizedTransaction.mockResolvedValueOnce({
      ok: false,
      reason: 'conflict',
    })
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      { category: 'expense_bank_fees', vatTreatment: 'exempt', allowDuplicate: true },
    )

    expect(result).toMatchObject({ status: 409, errorCode: 'SETTLEMENT_ACCOUNT_DRIFT' })
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
    expect(mockUpsertCounterpartyTemplate).not.toHaveBeenCalled()
  })

  it('persists duplicate dismissal and learning only after successful attachment', async () => {
    mockDetectDuplicate.mockResolvedValueOnce({
      transaction_id: 'tx-existing',
      journal_entry_id: 'je-existing',
      voucher_label: 'A42',
      entry_date: '2026-08-02',
      description: 'Possible duplicate',
      amount: -150,
      currency: 'SEK',
      amount_in_currency: -150,
      amount_verified: true,
      unverified_reason: null,
    })
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
      { data: [] },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      { category: 'expense_bank_fees', vatTreatment: 'exempt', allowDuplicate: true },
    )

    expect(result.data?.journal_entry_id).toBe('je-revolut-fee')
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    expect(mockUpsertCounterpartyTemplate).toHaveBeenCalledTimes(1)
    const attachmentOrder = mockAttachCategorizedTransaction.mock.invocationCallOrder[0]
    expect(attachmentOrder).toBeLessThan(mockAppendProcessingHistory.mock.invocationCallOrder[0])
    expect(attachmentOrder).toBeLessThan(mockUpsertCounterpartyTemplate.mock.invocationCallOrder[0])
  })

  it('surfaces the posted voucher id when storno compensation fails', async () => {
    mockAttachCategorizedTransaction.mockResolvedValueOnce({
      ok: false,
      reason: 'conflict',
      partialPostedIds: { journal_entry_id: 'je-revolut-fee' },
    })
    const supabase = queuedSupabase([
      { data: revolutFee },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'period-2026' }] },
      { data: null },
    ])

    const result = await categorizeMatchedTransaction(
      supabase,
      'user-1',
      'company-1',
      revolutFee.id,
      {
        category: 'expense_bank_fees',
        vatTreatment: 'exempt',
        expectedSettlement: {
          cashAccountId: 'cash-revolut-sek',
          ledgerAccount: '1931',
        },
      },
    )

    expect(result).toMatchObject({
      status: 409,
      errorCode: 'SETTLEMENT_ACCOUNT_DRIFT',
      partialPostedIds: { journal_entry_id: 'je-revolut-fee' },
    })
  })

  it('throws a typed database error when the transaction fetch fails', async () => {
    const supabase = queuedSupabase([
      { data: null, error: { message: 'connection reset', code: '08006' } },
    ])

    await expect(
      categorizeMatchedTransaction(
        supabase,
        'user-1',
        'company-1',
        'tx-1',
        { category: 'expense_bank_fees' },
      ),
    ).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'fetch_transaction',
    })
  })
})
