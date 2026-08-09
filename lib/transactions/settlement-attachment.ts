import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookkeepingDatabaseError,
  PostCommitReadbackError,
} from '@/lib/bookkeeping/errors'
import { compensateTransactionCategorization } from '@/lib/bookkeeping/engine'
import type { Logger } from '@/lib/logger'
import type { TransactionCategory } from '@/types'

export interface CategorizationAttachmentParams {
  companyId: string
  userId: string
  transactionId: string
  expectedJournalEntryId: string | null
  expectedCashAccountId: string | null
  expectedSettlementAccount: string
  isBusiness: boolean
  category: TransactionCategory
  journalEntryId: string
}

export type CategorizationAttachmentResult =
  | { ok: true }
  | {
      ok: false
      reason: 'conflict' | 'database_error'
      error?: BookkeepingDatabaseError
      partialPostedIds?: Record<string, string>
    }

function databaseErrorCause(error: unknown, data: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return `Atomic attachment returned an unverifiable result: ${JSON.stringify(data)}`
}

function postedArtifactIds(
  originalJournalEntryId: string,
  reversalJournalEntryIds: string[] = [],
): Record<string, string> {
  const ids: Record<string, string> = { journal_entry_id: originalJournalEntryId }
  reversalJournalEntryIds.forEach((id, index) => {
    ids[index === 0 ? 'reversal_journal_entry_id' : `reversal_journal_entry_${index + 1}_id`] = id
  })
  return ids
}

interface AtomicCompensationParams {
  companyId: string
  userId: string
  transactionId: string
  journalEntryId: string
}

interface AtomicCompensationResult {
  compensationVerified: boolean
  partialPostedIds?: Record<string, string>
}

async function compensateCategorizationPosting(
  supabase: SupabaseClient,
  params: AtomicCompensationParams,
  log: Logger,
  failureContext: string,
): Promise<AtomicCompensationResult> {
  try {
    const result = await compensateTransactionCategorization(supabase, {
      companyId: params.companyId,
      userId: params.userId,
      transactionId: params.transactionId,
      originalJournalEntryId: params.journalEntryId,
    })
    if (result.compensationVerified) return { compensationVerified: true }

    log.error(
      'Atomic categorization compensation failed or was unverifiable',
      result.error,
      {
        companyId: params.companyId,
        transactionId: params.transactionId,
        journalEntryId: params.journalEntryId,
        attachmentFailure: failureContext,
      },
    )
    return {
      compensationVerified: false,
      partialPostedIds: result.partialPostedIds,
    }
  } catch (error) {
    const compensationError = new BookkeepingDatabaseError(
      'compensate_transaction_categorization',
      databaseErrorCause(error, null),
    )
    log.error(
      'Atomic categorization compensation failed or was unverifiable',
      compensationError,
      {
        companyId: params.companyId,
        transactionId: params.transactionId,
        journalEntryId: params.journalEntryId,
        attachmentFailure: failureContext,
      },
    )
    return {
      compensationVerified: false,
      partialPostedIds: postedArtifactIds(params.journalEntryId),
    }
  }
}

export type PostCommitCategorizationCompensationResult =
  | { handled: false }
  | {
      handled: true
      journalEntryId: string
      voucherNumber: number | null
      compensationVerified: boolean
      partialPostedIds?: Record<string, string>
    }

/**
 * A successful commit with failed readback cannot safely proceed to
 * attachment because the complete posted row was not verified. Compensate the
 * known durable ID directly and retain every posted ID if storno verification
 * is also unavailable.
 */
export async function compensatePostCommitReadbackFailure(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    transactionId: string
    error: unknown
  },
  log: Logger,
): Promise<PostCommitCategorizationCompensationResult> {
  if (!(params.error instanceof PostCommitReadbackError)) {
    return { handled: false }
  }

  const compensation = await compensateCategorizationPosting(
    supabase,
    {
      companyId: params.companyId,
      userId: params.userId,
      transactionId: params.transactionId,
      journalEntryId: params.error.journalEntryId,
    },
    log,
    'post_commit_readback_failed',
  )
  return {
    handled: true,
    journalEntryId: params.error.journalEntryId,
    voucherNumber: params.error.voucherNumber,
    compensationVerified: compensation.compensationVerified,
    ...(compensation.partialPostedIds
      ? { partialPostedIds: compensation.partialPostedIds }
      : {}),
  }
}

/**
 * Atomically attach a categorization using the exact settlement provenance
 * that was used to create the voucher. Any failure after a voucher was posted
 * is compensated with a storno. The original posted id is returned only when
 * that compensation fails.
 */
export async function attachCategorizedTransaction(
  supabase: SupabaseClient,
  params: CategorizationAttachmentParams,
  log: Logger,
): Promise<CategorizationAttachmentResult> {
  let data: unknown = null
  let attachmentError: unknown = null
  try {
    const result = await supabase.rpc('attach_transaction_categorization', {
      p_company_id: params.companyId,
      p_transaction_id: params.transactionId,
      p_expected_journal_entry_id: params.expectedJournalEntryId,
      p_expected_cash_account_id: params.expectedCashAccountId,
      p_expected_settlement_account: params.expectedSettlementAccount,
      p_is_business: params.isBusiness,
      p_category: params.category,
      p_journal_entry_id: params.journalEntryId,
    })
    data = result.data
    attachmentError = result.error
  } catch (error) {
    attachmentError = error
  }

  if (!attachmentError && data === true) return { ok: true }

  const reason = !attachmentError && data === false ? 'conflict' : 'database_error'
  const databaseError = reason === 'database_error'
    ? new BookkeepingDatabaseError(
        'attach_transaction_categorization',
        databaseErrorCause(attachmentError, data),
      )
    : undefined

  const compensation = await compensateCategorizationPosting(
    supabase,
    {
      companyId: params.companyId,
      userId: params.userId,
      transactionId: params.transactionId,
      journalEntryId: params.journalEntryId,
    },
    log,
    reason,
  )

  if (!compensation.compensationVerified) {
    return {
      ok: false,
      reason,
      ...(databaseError ? { error: databaseError } : {}),
      partialPostedIds: compensation.partialPostedIds,
    }
  }

  return {
    ok: false,
    reason,
    ...(databaseError ? { error: databaseError } : {}),
  }
}
