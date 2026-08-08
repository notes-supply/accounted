import type { SupabaseClient } from '@supabase/supabase-js'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import type { TransactionCategory } from '@/types'

export type ExistingCategorizationConflictReason =
  | 'journal_missing'
  | 'journal_identity_mismatch'
  | 'metadata_unprovable'
  | 'transaction_metadata_drift'
  | 'requested_change'

export type ExistingCategorizationVerification =
  | { ok: true }
  | {
      ok: false
      kind: 'database_error'
      error: BookkeepingDatabaseError
    }
  | {
      ok: false
      kind: 'conflict'
      reason: ExistingCategorizationConflictReason
    }

interface ExistingCategorizationTransaction {
  id: string
  company_id: string
  journal_entry_id: string
  category: TransactionCategory | null
  is_business: boolean | null
}

/**
 * Prove that an existing transaction pointer, immutable journal metadata, and
 * the current request all describe the exact same categorization. Any missing
 * legacy provenance fails closed because a posted voucher cannot be edited to
 * make a requested change true retroactively.
 */
export async function verifyExistingCategorization(
  supabase: SupabaseClient,
  params: {
    companyId: string
    transaction: ExistingCategorizationTransaction
    requestedCategory: TransactionCategory
    requestedIsBusiness: boolean
  },
): Promise<ExistingCategorizationVerification> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select(
      'id, company_id, status, source_type, source_id, categorization_category, categorization_is_business',
    )
    .eq('id', params.transaction.journal_entry_id)
    .eq('company_id', params.companyId)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      kind: 'database_error',
      error: new BookkeepingDatabaseError(
        'verify_existing_transaction_categorization',
        error.message,
      ),
    }
  }
  if (!data) {
    return { ok: false, kind: 'conflict', reason: 'journal_missing' }
  }

  const journal = data as {
    id: string
    company_id: string
    status: string
    source_type: string
    source_id: string | null
    categorization_category: TransactionCategory | null
    categorization_is_business: boolean | null
  }
  if (
    journal.id !== params.transaction.journal_entry_id ||
    journal.company_id !== params.companyId ||
    journal.status !== 'posted' ||
    journal.source_type !== 'bank_transaction' ||
    journal.source_id !== params.transaction.id ||
    params.transaction.company_id !== params.companyId
  ) {
    return {
      ok: false,
      kind: 'conflict',
      reason: 'journal_identity_mismatch',
    }
  }

  if (
    journal.categorization_category === null ||
    typeof journal.categorization_is_business !== 'boolean' ||
    journal.categorization_is_business !==
      (journal.categorization_category !== 'private')
  ) {
    return { ok: false, kind: 'conflict', reason: 'metadata_unprovable' }
  }

  if (
    params.transaction.category !== journal.categorization_category ||
    params.transaction.is_business !== journal.categorization_is_business
  ) {
    return {
      ok: false,
      kind: 'conflict',
      reason: 'transaction_metadata_drift',
    }
  }

  if (
    params.requestedCategory !== journal.categorization_category ||
    params.requestedIsBusiness !== journal.categorization_is_business
  ) {
    return { ok: false, kind: 'conflict', reason: 'requested_change' }
  }

  return { ok: true }
}

export function existingCategorizationMappingFields(input: {
  account_override?: unknown
  counterparty_template_id?: unknown
  template_id?: unknown
  vat_treatment?: unknown
  dimensions?: Record<string, string>
}): string[] {
  return [
    input.account_override !== undefined ? 'account_override' : null,
    input.counterparty_template_id !== undefined
      ? 'counterparty_template_id'
      : null,
    input.template_id !== undefined ? 'template_id' : null,
    input.vat_treatment !== undefined ? 'vat_treatment' : null,
    input.dimensions && Object.keys(input.dimensions).length > 0
      ? 'dimensions'
      : null,
  ].filter((field): field is string => field !== null)
}
