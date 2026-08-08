/**
 * The agent/MCP commit path (lib/pending-operations/commit.ts) must run the same
 * duplicate guards as the web routes: it previously bypassed them entirely,
 * which let an approved staged op double-book an affärshändelse already in the
 * ledger (the production case: a bank line booked on top of an invoice
 * "markera som betald" voucher or a salary payout).
 *
 * These tests drive the public `commitPendingOperation` dispatcher (the executor
 * functions are private) and assert the op is auto-rejected (409) when a
 * duplicate is detected. The detection functions themselves are unit-tested in
 * lib/transactions/__tests__/booking-duplicate-detection.test.ts and
 * lib/invoices/__tests__/duplicate-payment-detection.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import type { PendingOperation } from '@/types'

const mockDetectBookingDuplicate = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectBookingDuplicate(...args),
}))

const mockFindDupPayments = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: (...args: unknown[]) => mockFindDupPayments(...args),
}))

const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

const mockResolveSettlementAccount = vi.fn()
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/transaction-entries')>(
    '@/lib/bookkeeping/transaction-entries',
  )
  return {
    ...actual,
    createTransactionJournalEntry: (...args: unknown[]) =>
      mockCreateTransactionJournalEntry(...args),
  }
})

const mockAttachCategorizedTransaction = vi.fn()
vi.mock('@/lib/transactions/settlement-attachment', () => ({
  attachCategorizedTransaction: (...args: unknown[]) =>
    mockAttachCategorizedTransaction(...args),
}))

import { commitPendingOperation } from '../commit'

/** Queue-based supabase mock: each `from()` resolves to the next queued result. */
function queuedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const from = vi.fn((table: string) => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
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

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'categorize_transaction',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

const voucherCandidate = {
  transaction_id: null,
  journal_entry_id: 'je-existing',
  voucher_label: 'A2',
  entry_date: '2026-03-30',
  description: 'Inbetalning kundfaktura 2026001',
  amount: 98565,
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockResolveSettlementAccount.mockResolvedValue('1930')
  mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-new' })
  mockAttachCategorizedTransaction.mockResolvedValue({ ok: true })
})

describe('commit duplicate guard: categorize_transaction (reverse / book the bank line)', () => {
  it('releases the claim retryably when company-settings loading throws a typed database error', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      {
        data: {
          id: 'tx-1',
          date: '2026-03-26',
          amount: -150,
          cash_account_id: null,
          journal_entry_id: null,
        },
      },
      { data: null, error: { message: 'permission denied', code: '42501' } },
      { data: { id: 'op-1', status: 'pending' } },
    ]) as never as { __calls: Array<{ table: string; method: string; args: unknown[] }> }
    const op = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'private',
        cash_account_id: null,
        settlement_account: '1930',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'BOOKKEEPING_DATABASE_ERROR',
    })
    const statusUpdates = supabase.__calls
      .filter((call) => call.table === 'pending_operations' && call.method === 'update')
      .map((call) => call.args[0])
    expect(statusUpdates).toContainEqual({ status: 'pending' })
  })

  it('does not report pending when the guarded retry release updates zero rows', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      {
        data: {
          id: 'tx-1',
          date: '2026-03-26',
          amount: -150,
          cash_account_id: null,
          journal_entry_id: null,
        },
      },
      { data: null, error: { message: 'connection reset', code: '08006' } },
      { data: null, error: null },
    ]) as never as { __calls: Array<{ table: string; method: string; args: unknown[] }> }
    const op = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'private',
        cash_account_id: null,
        settlement_account: '1930',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 409,
      code: 'BOOKKEEPING_DATABASE_ERROR_RELEASE_CONFLICT',
    })
  })

  it('reports a retry-release database error without claiming the operation is pending', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      {
        data: {
          id: 'tx-1',
          date: '2026-03-26',
          amount: -150,
          cash_account_id: null,
          journal_entry_id: null,
        },
      },
      { data: null, error: { message: 'connection reset', code: '08006' } },
      { data: null, error: { message: 'write timeout', code: '08006' } },
    ])
    const op = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'private',
        cash_account_id: null,
        settlement_account: '1930',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'BOOKKEEPING_DATABASE_ERROR_RELEASE_FAILED',
    })
  })

  it('releases the claim when the transaction fetch has a database error', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: null, error: { message: 'connection reset', code: '08006' } },
      { data: { id: 'op-1', status: 'pending' } },
    ]) as never as { __calls: Array<{ table: string; method: string; args: unknown[] }> }
    const op = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'expense_bank_fees',
        cash_account_id: 'cash-revolut',
        settlement_account: '1931',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'BOOKKEEPING_DATABASE_ERROR',
    })
    const statusUpdates = supabase.__calls
      .filter((call) => call.table === 'pending_operations' && call.method === 'update')
      .map((call) => call.args[0])
    expect(statusUpdates).toContainEqual({ status: 'pending' })
  })

  it('terminally rejects a truly missing transaction', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: null, error: null },
      { data: null },
    ]) as never as { __calls: Array<{ table: string; method: string; args: unknown[] }> }
    const op = makePendingOp({
      params: {
        transaction_id: 'tx-missing',
        category: 'expense_bank_fees',
        cash_account_id: null,
        settlement_account: '1930',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({ status: 'rejected', http_status: 404 })
    const statusUpdates = supabase.__calls
      .filter((call) => call.table === 'pending_operations' && call.method === 'update')
      .map((call) => call.args[0])
    expect(statusUpdates).not.toContainEqual({ status: 'pending' })
    expect(statusUpdates).toContainEqual(expect.objectContaining({ status: 'rejected' }))
  })

  it('releases the claim back to pending when settlement lookup has a transient database failure', async () => {
    const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
    mockDetectBookingDuplicate.mockResolvedValue(null)
    mockResolveSettlementAccount.mockRejectedValueOnce(
      new BookkeepingDatabaseError('resolve_settlement_account', 'temporary outage'),
    )
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: -150, cash_account_id: 'cash-revolut', journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: { id: 'op-1', status: 'pending' } },
    ]) as never as { __calls: Array<{ table: string; method: string; args: unknown[] }> }

    const op = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'expense_bank_fees',
        cash_account_id: 'cash-revolut',
        settlement_account: '1931',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed',
      http_status: 500,
      code: 'BOOKKEEPING_DATABASE_ERROR',
    })
    const statusUpdates = supabase.__calls
      .filter((call) => call.table === 'pending_operations' && call.method === 'update')
      .map((call) => call.args[0])
    expect(statusUpdates).toContainEqual({ status: 'pending' })
  })

  it('dispatches the authoritative params returned by the atomic claim', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(voucherCandidate)
    const supabase = queuedSupabase([
      {
        data: {
          id: 'op-1',
          params: {
            transaction_id: 'tx-1',
            category: 'income',
            cash_account_id: null,
            settlement_account: '1930',
          },
        },
      },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: null },
    ])

    const staleCallerSnapshot = makePendingOp({
      params: {
        transaction_id: 'tx-1',
        category: 'income',
        allow_duplicate: true,
        cash_account_id: null,
        settlement_account: '1930',
      },
    })

    const result = await commitPendingOperation(
      supabase,
      'user-1',
      'company-1',
      staleCallerSnapshot,
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('auto-rejects (409) when a ledger voucher already books this movement', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(voucherCandidate)
    // claim → transaction fetch → reject update
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: null },
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income', cash_account_id: null, settlement_account: '1930' },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('does not enforce the guard when allow_duplicate=true, but records the dismissal to behandlingshistorik', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(voucherCandidate)
    // The booking proceeds past the guard and attaches successfully. Only then
    // may the bypass leave a durable BankTransactionDuplicateDismissed record so an
    // auditor can reconstruct why the duplicate was allowed (BFNAR 2013:2 kap 8).
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] },
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income', allow_duplicate: true, cash_account_id: null, settlement_account: '1930' },
    })

    await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    // Detection still runs once to capture the dismissed candidate for audit.
    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    const event = mockAppendProcessingHistory.mock.calls[0][0]
    expect(event).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'BankTransaction',
      aggregateId: 'tx-1',
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
    })
    expect(event.payload).toMatchObject({
      transaction_id: 'tx-1',
      dismissed_journal_entry_id: 'je-existing',
      via: 'allow_duplicate',
    })
  })

  it('records no dismissal when allow_duplicate=true but no duplicate is actually present', async () => {
    mockDetectBookingDuplicate.mockResolvedValue(null)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'tx-1', date: '2026-03-26', amount: 98565, cash_account_id: null, journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] },
    ])

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'income', allow_duplicate: true, cash_account_id: null, settlement_account: '1930' },
    })

    await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockDetectBookingDuplicate).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})

describe('commit duplicate guard: mark_invoice_paid (forward / book the payment)', () => {
  it('auto-rejects (409) when an unlinked bank transaction already looks like the payment', async () => {
    mockFindDupPayments.mockResolvedValue([
      { id: 'tx-9', date: '2026-03-26', amount: 98565, description: '2026001', merchant_name: null, reference: null, match_reason: 'ocr_exact', match_confidence: 0.99 },
    ])
    // claim → invoice fetch → reject update
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'inv-1', invoice_number: '2026001', status: 'sent', total: 98565, remaining_amount: 98565, customer: { name: 'Arcim Technology AB' } } },
      { data: null },
    ])

    const op = makePendingOp({
      operation_type: 'mark_invoice_paid',
      params: { invoice_id: 'inv-1', payment_date: '2026-03-30' },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    expect(mockFindDupPayments).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('does not enforce the guard when allow_duplicate=true, but records the dismissal to behandlingshistorik', async () => {
    mockFindDupPayments.mockResolvedValue([
      { id: 'tx-9', date: '2026-03-26', amount: 98565, description: '2026001', merchant_name: null, reference: null, match_reason: 'ocr_exact', match_confidence: 0.99 },
    ])
    // claim → invoice fetch → company_settings → bare downstream (allowed to fail)
    const supabase = queuedSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'inv-1', invoice_number: '2026001', status: 'sent', total: 98565, remaining_amount: 98565, customer: { name: 'Arcim Technology AB' } } },
      { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' } },
    ])

    const op = makePendingOp({
      operation_type: 'mark_invoice_paid',
      params: { invoice_id: 'inv-1', payment_date: '2026-03-30', allow_duplicate: true },
    })

    const result = await commitPendingOperation(supabase, 'user-1', 'company-1', op)

    // Guard not enforced: not auto-rejected at the duplicate-payment guard.
    expect(result.status).not.toBe('rejected')
    expect(mockFindDupPayments).toHaveBeenCalledTimes(1)
    expect(mockAppendProcessingHistory).toHaveBeenCalledTimes(1)
    const event = mockAppendProcessingHistory.mock.calls[0][0]
    expect(event).toMatchObject({
      companyId: 'company-1',
      aggregateType: 'System',
      aggregateId: 'inv-1',
      eventType: 'InvoiceDuplicatePaymentDismissed',
      actor: { type: 'user', id: 'user-1' },
    })
    expect(event.payload).toMatchObject({
      invoice_id: 'inv-1',
      dismissed_transaction_ids: ['tx-9'],
      candidate_count: 1,
      via: 'allow_duplicate',
    })
    // PII-safe: no customer or merchant name in the payload.
    expect(JSON.stringify(event.payload)).not.toContain('Arcim')
  })
})
