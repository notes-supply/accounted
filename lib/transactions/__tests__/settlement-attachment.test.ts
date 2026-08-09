import { beforeEach, describe, expect, it, vi } from 'vitest'

const reverseEntryMock = vi.fn()
const compensateTransactionCategorizationMock = vi.fn()

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
  compensateTransactionCategorization: (...args: unknown[]) =>
    compensateTransactionCategorizationMock(...args),
}))

import {
  attachCategorizedTransaction,
  compensatePostCommitReadbackFailure,
} from '../settlement-attachment'
import type { CategorizationAttachmentParams } from '../settlement-attachment'
import { BookkeepingDatabaseError, PostCommitReadbackError } from '@/lib/bookkeeping/errors'

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}

function rpcSupabase(
  result: { data: unknown; error: unknown },
  compensation: { data: unknown; error: unknown } = {
    data: {
      status: 'reversed',
      original_journal_entry_id: 'je-1',
      reversal_journal_entry_ids: ['je-storno'],
      original_pointer_cleared: true,
    },
    error: null,
  },
) {
  const data = compensation.data as {
    status?: string
    original_journal_entry_id?: string
    reversal_journal_entry_ids?: string[]
    original_pointer_cleared?: boolean
  } | null
  const reversalIds = data?.reversal_journal_entry_ids ?? []
  const partialPostedIds: Record<string, string> = { journal_entry_id: 'je-1' }
  reversalIds.forEach((id, index) => {
    partialPostedIds[
      index === 0 ? 'reversal_journal_entry_id' : `reversal_journal_entry_${index + 1}_id`
    ] = id
  })
  const verified =
    !compensation.error &&
    data?.original_journal_entry_id === 'je-1' &&
    data.original_pointer_cleared === true &&
    reversalIds.length === 1 &&
    ['reversed', 'already_reversed', 'recovered_existing_reversal'].includes(
      data.status ?? '',
    )
  compensateTransactionCategorizationMock.mockResolvedValueOnce(
    verified
      ? {
          compensationVerified: true,
          status: data!.status,
          originalEntry: { id: 'je-1' },
          reversalEntry: { id: reversalIds[0] },
        }
      : {
          compensationVerified: false,
          partialPostedIds,
          error: new BookkeepingDatabaseError(
            compensation.error ? 'compensate_transaction_categorization' : 'verify_transaction_compensation',
            (compensation.error as { message?: string } | null)?.message ?? 'unverifiable result',
          ),
        },
  )
  return {
    rpc: vi.fn().mockResolvedValueOnce(result),
  }
}

const baseParams: CategorizationAttachmentParams = {
  companyId: 'company-1',
  userId: 'user-1',
  transactionId: 'tx-1',
  expectedJournalEntryId: null,
  expectedCashAccountId: 'cash-1',
  expectedSettlementAccount: '1931',
  isBusiness: true,
  category: 'expense_bank_fees',
  journalEntryId: 'je-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  reverseEntryMock.mockResolvedValue({ id: 'je-storno' })
  compensateTransactionCategorizationMock.mockResolvedValue({
    compensationVerified: true,
    status: 'reversed',
    originalEntry: { id: 'je-1' },
    reversalEntry: { id: 'je-storno' },
  })
})

describe('attachCategorizedTransaction', () => {
  it('delegates compensation to the bookkeeping engine without invoking the writer RPC here', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) }

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        originalJournalEntryId: 'je-1',
      },
    )
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      expect.anything(),
    )
  })

  it('passes the complete settlement provenance to the atomic RPC', async () => {
    const supabase = rpcSupabase({ data: true, error: null })

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toEqual({ ok: true })
    expect(supabase.rpc).toHaveBeenCalledWith(
      'attach_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_expected_journal_entry_id: null,
        p_expected_cash_account_id: 'cash-1',
        p_expected_settlement_account: '1931',
        p_is_business: true,
        p_category: 'expense_bank_fees',
        p_journal_entry_id: 'je-1',
      },
    )
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('uses the atomic categorization compensation RPC after a clean attachment mismatch', async () => {
    const supabase = rpcSupabase({ data: false, error: null })

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        originalJournalEntryId: 'je-1',
      },
    )
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('atomically compensates a posted voucher after an attachment database error', async () => {
    const supabase = rpcSupabase({
      data: null,
      error: { message: 'connection reset', code: '08006' },
    })

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({ ok: false, reason: 'database_error' })
    expect(result).not.toHaveProperty('partialPostedIds')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledTimes(1)
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('compensates a posted voucher when attachment transport throws before a response', async () => {
    const supabase = {
      rpc: vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce({
          data: {
            status: 'reversed',
            original_journal_entry_id: 'je-1',
            reversal_journal_entry_ids: ['je-storno'],
            original_pointer_cleared: true,
          },
          error: null,
        }),
    }

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'database_error',
      error: {
        name: 'BookkeepingDatabaseError',
        operation: 'attach_transaction_categorization',
        cause: 'fetch failed',
      },
    })
    expect(result).not.toHaveProperty('partialPostedIds')
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        originalJournalEntryId: 'je-1',
      },
    )
  })

  it('exposes the original posted id when thrown attachment and compensation transports are unverifiable', async () => {
    compensateTransactionCategorizationMock.mockRejectedValueOnce(
      new TypeError('compensation network failure'),
    )
    const supabase = {
      rpc: vi.fn().mockRejectedValueOnce(new TypeError('attach network failure')),
    }

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'database_error',
      error: {
        operation: 'attach_transaction_categorization',
        cause: 'attach network failure',
      },
      partialPostedIds: { journal_entry_id: 'je-1' },
    })
    expect(log.error).toHaveBeenCalledWith(
      'Atomic categorization compensation failed or was unverifiable',
      expect.objectContaining({
        name: 'BookkeepingDatabaseError',
        operation: 'compensate_transaction_categorization',
        cause: 'compensation network failure',
      }),
      expect.objectContaining({ journalEntryId: 'je-1' }),
    )
  })

  it('exposes every known posted id after thrown attachment and unverified compensation', async () => {
    compensateTransactionCategorizationMock.mockResolvedValueOnce({
      compensationVerified: false,
      partialPostedIds: {
        journal_entry_id: 'je-1',
        reversal_journal_entry_id: 'je-storno-1',
        reversal_journal_entry_2_id: 'je-storno-2',
      },
      error: new BookkeepingDatabaseError(
        'verify_transaction_compensation',
        'unverified existing reversals',
      ),
    })
    const supabase = {
      rpc: vi.fn().mockRejectedValueOnce(new TypeError('attach network failure')),
    }

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'database_error',
      partialPostedIds: {
        journal_entry_id: 'je-1',
        reversal_journal_entry_id: 'je-storno-1',
        reversal_journal_entry_2_id: 'je-storno-2',
      },
    })
  })

  it('surfaces both posted ids when atomic compensation cannot clear the original pointer', async () => {
    const supabase = rpcSupabase(
      { data: null, error: { message: 'connection reset', code: '08006' } },
      {
        data: {
          status: 'reversed',
          original_journal_entry_id: 'je-1',
          reversal_journal_entry_ids: ['je-storno'],
          original_pointer_cleared: false,
        },
        error: null,
      },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'database_error',
      partialPostedIds: {
        journal_entry_id: 'je-1',
        reversal_journal_entry_id: 'je-storno',
      },
    })
  })

  it('surfaces the original posted id when atomic compensation errors', async () => {
    const supabase = rpcSupabase(
      { data: false, error: null },
      { data: null, error: { message: 'write timeout', code: '08006' } },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      partialPostedIds: { journal_entry_id: 'je-1' },
    })
  })

  it('accepts a concurrent different transaction pointer without overwriting it', async () => {
    const supabase = rpcSupabase({ data: false, error: null })

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toEqual({ ok: false, reason: 'conflict' })
  })

  it('treats a missing compensation result as unverifiable', async () => {
    const supabase = rpcSupabase(
      { data: null, error: { message: 'connection reset', code: '08006' } },
      { data: null, error: null },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      partialPostedIds: { journal_entry_id: 'je-1' },
    })
  })

  it('treats a non-boolean RPC result as unverifiable and compensates', async () => {
    const supabase = rpcSupabase({ data: null, error: null })

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({ ok: false, reason: 'database_error' })
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledTimes(1)
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('surfaces the original posted id when database-error compensation fails', async () => {
    const supabase = rpcSupabase(
      { data: null, error: { message: 'timeout' } },
      { data: null, error: { message: 'period locked' } },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'database_error',
      partialPostedIds: { journal_entry_id: 'je-1' },
    })
  })

  it('surfaces the original posted id when conflict compensation fails', async () => {
    const supabase = rpcSupabase(
      { data: false, error: null },
      { data: null, error: { message: 'period locked' } },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      partialPostedIds: { journal_entry_id: 'je-1' },
    })
  })

  it('accepts the authoritative existing reversal without creating another', async () => {
    const supabase = rpcSupabase(
      { data: false, error: null },
      {
        data: {
          status: 'already_reversed',
          original_journal_entry_id: 'je-1',
          reversal_journal_entry_ids: ['je-existing-storno'],
          original_pointer_cleared: true,
        },
        error: null,
      },
    )

    await expect(
      attachCategorizedTransaction(supabase as never, baseParams, log as never),
    ).resolves.toEqual({ ok: false, reason: 'conflict' })
  })

  it('exposes every posted artifact when existing reversal state is ambiguous', async () => {
    const supabase = rpcSupabase(
      { data: false, error: null },
      {
        data: {
          status: 'ambiguous_existing_reversals',
          original_journal_entry_id: 'je-1',
          reversal_journal_entry_ids: ['je-storno-1', 'je-storno-2'],
          original_pointer_cleared: false,
        },
        error: null,
      },
    )

    const result = await attachCategorizedTransaction(
      supabase as never,
      baseParams,
      log as never,
    )

    expect(result).toMatchObject({
      partialPostedIds: {
        journal_entry_id: 'je-1',
        reversal_journal_entry_id: 'je-storno-1',
        reversal_journal_entry_2_id: 'je-storno-2',
      },
    })
  })
})

describe('compensatePostCommitReadbackFailure', () => {
  it('atomically compensates the known posted journal without attempting attachment', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          status: 'reversed',
          original_journal_entry_id: 'je-readback',
          reversal_journal_entry_ids: ['je-storno'],
          original_pointer_cleared: true,
        },
        error: null,
      }),
    }

    const result = await compensatePostCommitReadbackFailure(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        error: new PostCommitReadbackError('je-readback', 41, 'timeout'),
      },
      log as never,
    )

    expect(result).toEqual({
      handled: true,
      journalEntryId: 'je-readback',
      voucherNumber: 41,
      compensationVerified: true,
    })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(compensateTransactionCategorizationMock).toHaveBeenCalledWith(
      supabase,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        originalJournalEntryId: 'je-readback',
      },
    )
  })

  it('exposes the durable posted id when compensation is unverifiable', async () => {
    compensateTransactionCategorizationMock.mockResolvedValueOnce({
      compensationVerified: false,
      partialPostedIds: { journal_entry_id: 'je-readback' },
      error: new BookkeepingDatabaseError(
        'compensate_transaction_categorization',
        'connection reset',
      ),
    })
    const supabase = {
      rpc: vi.fn(),
    }

    const result = await compensatePostCommitReadbackFailure(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        error: new PostCommitReadbackError('je-readback', 41, 'timeout'),
      },
      log as never,
    )

    expect(result).toEqual({
      handled: true,
      journalEntryId: 'je-readback',
      voucherNumber: 41,
      compensationVerified: false,
      partialPostedIds: { journal_entry_id: 'je-readback' },
    })
  })

  it('does nothing for an ordinary pre-commit error', async () => {
    const supabase = { rpc: vi.fn() }

    const result = await compensatePostCommitReadbackFailure(
      supabase as never,
      {
        companyId: 'company-1',
        userId: 'user-1',
        transactionId: 'tx-1',
        error: new Error('validation failed'),
      },
      log as never,
    )

    expect(result).toEqual({ handled: false })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
