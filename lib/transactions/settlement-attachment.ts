import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookkeepingDatabaseError,
  PostCommitReadbackError,
} from '@/lib/bookkeeping/errors'
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

interface CategorizationCompensationData {
  status: string
  original_journal_entry_id: string
  reversal_journal_entry_ids: string[]
  original_pointer_cleared: boolean
}

function parseCompensationData(data: unknown): CategorizationCompensationData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  if (
    typeof row.status !== 'string' ||
    typeof row.original_journal_entry_id !== 'string' ||
    !Array.isArray(row.reversal_journal_entry_ids) ||
    !row.reversal_journal_entry_ids.every((id) => typeof id === 'string') ||
    typeof row.original_pointer_cleared !== 'boolean'
  ) {
    return null
  }
  return row as unknown as CategorizationCompensationData
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
  let compensationRaw: unknown = null
  let compensationError: unknown = null
  try {
    const result = await supabase.rpc(
      'compensate_transaction_categorization',
      {
        p_company_id: params.companyId,
        p_transaction_id: params.transactionId,
        p_original_journal_entry_id: params.journalEntryId,
      },
    )
    compensationRaw = result.data
    compensationError = result.error
  } catch (error) {
    compensationError = error
  }

  const compensation = parseCompensationData(compensationRaw)
  const reversalIds = compensation?.reversal_journal_entry_ids ?? []
  const compensationVerified =
    !compensationError &&
    compensation !== null &&
    compensation.original_journal_entry_id === params.journalEntryId &&
    compensation.original_pointer_cleared &&
    compensation.reversal_journal_entry_ids.length === 1 &&
    ['reversed', 'already_reversed', 'recovered_existing_reversal'].includes(
      compensation.status,
    )

  if (compensationVerified) return { compensationVerified: true }

  log.error(
    'Atomic categorization compensation failed or was unverifiable',
    compensationError
      ? new BookkeepingDatabaseError(
          'compensate_transaction_categorization',
          databaseErrorCause(compensationError, compensationRaw),
        )
      : new Error(`Unverifiable compensation result: ${JSON.stringify(compensationRaw)}`),
    {
      companyId: params.companyId,
      transactionId: params.transactionId,
      journalEntryId: params.journalEntryId,
      attachmentFailure: failureContext,
    },
  )
  return {
    compensationVerified: false,
    partialPostedIds: postedArtifactIds(params.journalEntryId, reversalIds),
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
