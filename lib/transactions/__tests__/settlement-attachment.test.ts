import { beforeEach, describe, expect, it, vi } from 'vitest'

const reverseEntryMock = vi.fn()

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => reverseEntryMock(...args),
}))

import {
  attachCategorizedTransaction,
  compensatePostCommitReadbackFailure,
} from '../settlement-attachment'
import type { CategorizationAttachmentParams } from '../settlement-attachment'
import { PostCommitReadbackError } from '@/lib/bookkeeping/errors'

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
  return {
    rpc: vi.fn()
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(compensation),
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
})

describe('attachCategorizedTransaction', () => {
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
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      'compensate_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_original_journal_entry_id: 'je-1',
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
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
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
    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      'compensate_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_original_journal_entry_id: 'je-1',
      },
    )
  })

  it('exposes the original posted id when thrown attachment and compensation transports are unverifiable', async () => {
    const supabase = {
      rpc: vi.fn()
        .mockRejectedValueOnce(new TypeError('attach network failure'))
        .mockRejectedValueOnce(new TypeError('compensation network failure')),
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
    const supabase = {
      rpc: vi.fn()
        .mockRejectedValueOnce(new TypeError('attach network failure'))
        .mockResolvedValueOnce({
          data: {
            status: 'unverified_existing_reversal',
            original_journal_entry_id: 'je-1',
            reversal_journal_entry_ids: ['je-storno-1', 'je-storno-2'],
            original_pointer_cleared: false,
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
    expect(supabase.rpc).toHaveBeenCalledTimes(2)
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
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_original_journal_entry_id: 'je-readback',
      },
    )
  })

  it('exposes the durable posted id when compensation is unverifiable', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection reset' },
      }),
    }

    const result = await compensatePostCommitReadbackFailure(
      supabase as never,
      {
        companyId: 'company-1',
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
        transactionId: 'tx-1',
        error: new Error('validation failed'),
      },
      log as never,
    )

    expect(result).toEqual({ handled: false })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
