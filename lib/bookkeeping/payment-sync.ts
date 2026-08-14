import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { JournalEntry } from '@/types'

const log = createLogger('payment-sync')

export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

type SupplierPaymentReversalCompletionStatus =
  | 'applied'
  | 'already_applied'
  | 'applied_legacy'
  | 'already_applied_legacy'
  | 'applied_v1_recovery'
  | 'already_applied_v1_recovery'

const SUPPLIER_PAYMENT_REVERSAL_COMPLETION_STATUSES: readonly SupplierPaymentReversalCompletionStatus[] = [
  'applied',
  'already_applied',
  'applied_legacy',
  'already_applied_legacy',
  'applied_v1_recovery',
  'already_applied_v1_recovery',
]

const SUPPLIER_PAYMENT_REVERSAL_RETRY_STATUSES: readonly SupplierPaymentReversalCompletionStatus[] = [
  'already_applied',
  'already_applied_legacy',
  'already_applied_v1_recovery',
]

function isSupplierPaymentReversalCompletionStatus(
  status: unknown,
): status is SupplierPaymentReversalCompletionStatus {
  return SUPPLIER_PAYMENT_REVERSAL_COMPLETION_STATUSES.includes(
    status as SupplierPaymentReversalCompletionStatus,
  )
}

function hasVerifiedSupplierEventPublication(
  result: {
    ok?: unknown
    status?: unknown
    event_publication?: {
      status?: unknown
      event_outbox_ids?: unknown
      event_log_count?: unknown
      webhook_delivery_count?: unknown
    }
  } | null,
): result is {
  ok: true
  status: SupplierPaymentReversalCompletionStatus
  event_publication: {
    status: 'published' | 'already_published'
    event_outbox_ids: [string, string]
    event_log_count: 0 | 2
    webhook_delivery_count: number
  }
} {
  if (result?.ok !== true || !isSupplierPaymentReversalCompletionStatus(result.status)) {
    return false
  }

  const publication = result.event_publication
  if (
    !publication
    || !Array.isArray(publication.event_outbox_ids)
    || publication.event_outbox_ids.length !== 2
    || !publication.event_outbox_ids.every(
      (id) => typeof id === 'string' && id.trim().length > 0,
    )
    || publication.event_outbox_ids[0] === publication.event_outbox_ids[1]
    || typeof publication.webhook_delivery_count !== 'number'
    || !Number.isInteger(publication.webhook_delivery_count)
    || publication.webhook_delivery_count < 0
  ) {
    return false
  }

  if (publication.status === 'published') {
    return publication.event_log_count === 2
  }

  return publication.status === 'already_published'
    && SUPPLIER_PAYMENT_REVERSAL_RETRY_STATUSES.includes(result.status)
    && (publication.event_log_count === 0 || publication.event_log_count === 2)
}

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}
/**
 * Non-correction vouchers gain supplier-payment semantics only from retained
 * allocation evidence. A fresh reversal requires an active allocation. A
 * recovery may also use an allocation already soft-reversed by the exact
 * original/storno pair. Missing evidence leaves an arbitrary reversal on the
 * normal non-posted error path.
 */
export async function hasSupplierPaymentReversalEvidence(
  supabase: SupabaseClient,
  companyId: string,
  originalJournalEntryId: string,
  stornoJournalEntryId?: string,
): Promise<boolean> {
  const active = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', originalJournalEntryId)
    .is('reversed_at', null)
    .limit(1)

  if (active.error) {
    throw new Error(`Failed to inspect supplier payment allocations: ${active.error.message}`)
  }
  if ((active.data ?? []).length > 0) return true
  if (!stornoJournalEntryId) return false

  const exactReversed = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', originalJournalEntryId)
    .eq('reversed_by_journal_entry_id', stornoJournalEntryId)
    .limit(1)

  if (exactReversed.error) {
    throw new Error(`Failed to inspect supplier payment reversal evidence: ${exactReversed.error.message}`)
  }
  return (exactReversed.data ?? []).length > 0
}

const MAX_SUPPLIER_CORRECTION_ANCESTRY_DEPTH = 32

type SupplierCorrectionAncestryEntry = Pick<
  JournalEntry,
  | 'id'
  | 'company_id'
  | 'status'
  | 'source_type'
  | 'correction_of_id'
  | 'reversed_by_id'
>

/**
 * Resolve the exact supplier-payment root behind a correction descendant.
 * Every correction ancestor must be a retained, company-scoped reversed row.
 * Missing, cyclic, cross-company, or over-deep ancestry fails closed because
 * otherwise reverseEntry could publish ordinary reversal events after skipping
 * the atomic supplier-state restoration.
 */
export async function resolveSupplierPaymentRootId(
  supabase: SupabaseClient,
  companyId: string,
  requested: SupplierCorrectionAncestryEntry,
): Promise<string | null> {
  if (requested.company_id !== companyId) {
    throw new Error('Could not verify supplier payment correction ancestry: company mismatch')
  }

  const visited = new Set<string>()
  let current = requested

  for (let depth = 0; depth <= MAX_SUPPLIER_CORRECTION_ANCESTRY_DEPTH; depth += 1) {
    if (visited.has(current.id)) {
      throw new Error(
        `Could not verify supplier payment correction ancestry: cyclic lineage at entry ${current.id}`,
      )
    }
    visited.add(current.id)

    if (current.id !== requested.id && current.status !== 'reversed') {
      throw new Error(
        `Could not verify supplier payment correction ancestry: non-reversed ancestor ${current.id}`,
      )
    }

    if (current.source_type !== 'correction') {
      if (current.correction_of_id) {
        throw new Error(
          `Could not verify supplier payment correction ancestry: malformed root ${current.id}`,
        )
      }
      if (
        current.source_type?.startsWith('supplier_invoice')
        && isPaymentSourceType(current.source_type)
      ) {
        return current.id
      }
      const rootHasEvidence = await hasSupplierPaymentReversalEvidence(
        supabase,
        companyId,
        current.id,
        requested.status === 'reversed'
          ? requested.reversed_by_id ?? undefined
          : undefined,
      )
      if (rootHasEvidence) return current.id

      // Older voucher-link flows could attach the retained allocation to the
      // exact live correction instead of its ancestry root. Accept that one
      // historical owner only after the full ancestry above has been verified.
      if (requested.id !== current.id) {
        const requestedHasEvidence = await hasSupplierPaymentReversalEvidence(
          supabase,
          companyId,
          requested.id,
          requested.status === 'reversed'
            ? requested.reversed_by_id ?? undefined
            : undefined,
        )
        if (requestedHasEvidence) return current.id
      }
      return null
    }

    const ancestorId = current.correction_of_id
    if (!ancestorId) {
      throw new Error(
        `Could not verify supplier payment correction ancestry: correction ${current.id} has no ancestor`,
      )
    }
    if (depth === MAX_SUPPLIER_CORRECTION_ANCESTRY_DEPTH) {
      throw new Error(
        'Could not verify supplier payment correction ancestry: maximum depth exceeded',
      )
    }

    const { data: ancestor, error } = await supabase
      .from('journal_entries')
      .select(
        'id, company_id, status, source_type, correction_of_id, reversed_by_id',
      )
      .eq('company_id', companyId)
      .eq('id', ancestorId)
      .maybeSingle()

    if (error || !ancestor) {
      throw new Error(
        `Could not verify supplier payment correction ancestry:`
        + ` missing or cross-company ancestor ${ancestorId}`,
      )
    }
    current = ancestor as SupplierCorrectionAncestryEntry
  }

  throw new Error(
    'Could not verify supplier payment correction ancestry: maximum depth exceeded',
  )
}


/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * attached to a payment journal entry. `reversalJournalEntryId` is required
 * when retained supplier allocation rows exist: those rows are soft-reversed
 * against the exact storno instead of being deleted.
 *
 * Returns the durable supplier publication state. The caller skips the full
 * EventBus and dispatches extensions only for a newly published intent.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>,
  reversalJournalEntryId?: string,
  supplierPaymentSemantics = false,
): Promise<'none' | 'published' | 'already_published'> {
  if (!isPaymentSourceType(entry.source_type) && !supplierPaymentSemantics) return 'none'

  const entryId = entry.id

  if (supplierPaymentSemantics || entry.source_type?.startsWith('supplier_invoice')) {
    if (!reversalJournalEntryId) {
      throw new Error(`Supplier payment reversal ${entryId} is missing its storno journal entry id`)
    }

    const { data, error } = await supabase.rpc('apply_supplier_payment_reversal', {
      p_company_id: companyId,
      p_original_journal_entry_id: entryId,
      p_storno_journal_entry_id: reversalJournalEntryId,
    })

    if (error) {
      log.error('Atomic supplier payment reversal failed', error, {
        companyId,
        journalEntryId: entryId,
        reversalJournalEntryId,
      })
      throw new Error(`Failed to restore supplier payment state: ${error.message}`)
    }

    const result = data as {
      ok?: unknown
      status?: unknown
      event_publication?: {
        status?: unknown
        event_outbox_ids?: unknown
        event_log_count?: unknown
        webhook_delivery_count?: unknown
      }
    } | null
    if (!hasVerifiedSupplierEventPublication(result)) {
      throw new Error(`Supplier payment reversal ${entryId} returned an invalid result`)
    }
    return result.event_publication.status
  } else {
    // Scoped like the supplier branch: filter by invoice_id + company_id so a
    // batch voucher's sibling payment rows don't break the .single().
    const { data: payment } = await supabase
      .from('invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    const { data: customerInvoice } = await supabase
      .from('invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (customerInvoice) {
      // For a partial reversal we take the exact amount from the payment row.
      // The fallback (full paid_amount) only applies when no payment row exists:
      // true for invoice_cash_payment, which is only ever booked on a FULL
      // payment, so reverting the whole paid_amount is correct there. Guarding
      // this keeps a future partial-cash path from over-reverting.
      const paymentAmount = payment?.amount ?? customerInvoice.paid_amount
      const newPaidAmount = roundOre(customerInvoice.paid_amount - paymentAmount)
      const safePaidAmount = Math.max(0, newPaidAmount)
      // The supplier branch already resets remaining_amount; the customer branch
      // never did, leaving it stale (= total) after a reversal so the invoice
      // showed fully unpaid yet stuck on 'paid'. Recompute from total. (The
      // .in('status', …) guard below can leave status/remaining un-updated if
      // the invoice isn't paid/partially_paid: only reachable on a non-storno
      // path; the payment-row delete + tx release still run, freeing the line.)
      const newRemaining = roundOre(customerInvoice.total - safePaidAmount)
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      await supabase
        .from('invoices')
        .update({
          status: revertStatus,
          paid_at: null,
          paid_amount: safePaidAmount,
          remaining_amount: newRemaining,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
        .in('status', ['paid', 'partially_paid'])
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't trip the (transaction_id,
    // invoice_id) / (journal_entry_id, invoice_id) unique indexes on
    // invoice_payments. Scoped to the source invoice: see the supplier
    // branch comment for the batch-voucher rationale.
    const { data: ipRows } = await supabase
      .from('invoice_payments')
      .select('transaction_id')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await supabase
      .from('invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await releaseLinkedTransactions(
      supabase,
      companyId,
      entryId,
      (ipRows ?? []).map((r) => (r as { transaction_id: string | null }).transaction_id),
      'invoice_id',
    )
  }
  return 'none'
}

/**
 * Detach any bank transactions still pointing at a reversed payment voucher so
 * the bank line returns to the inbox and becomes re-matchable. Without this, a
 * standalone storno (the reverse route / MCP reverse tool / delete-last-voucher)
 * leaves transactions.journal_entry_id pointing at a reversed JE: the match
 * POST refuses (invoice no longer matchable once we also fix its status) and the
 * line can't be re-booked or deleted. The match-invoice route already clears the
 * tx when IT stornos a conflicting auto-categorization JE; this covers every
 * other reversal path.
 *
 * Clears by journal_entry_id (covers the link even when the payment row was
 * missing) and by the captured payment-row transaction ids (covers a partial
 * match that cleared journal_entry_id but left invoice_id/category set). Only
 * the link/categorization columns are reset; the transaction row is preserved.
 */
async function releaseLinkedTransactions(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  paymentTransactionIds: Array<string | null>,
  invoiceColumn: 'invoice_id' | 'supplier_invoice_id',
): Promise<void> {
  const resetFields = {
    journal_entry_id: null,
    [invoiceColumn]: null,
    is_business: null,
    category: null,
  }

  const { data: releasedByEntry, error: byEntryError } = await supabase
    .from('transactions')
    .update(resetFields)
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .select('id')
  if (byEntryError) {
    // Best-effort like the rest of the sync: the storno itself already
    // committed, but a failed release leaves the bank line stuck on a
    // reversed JE, so it must be observable.
    log.error('Failed to release transactions by journal_entry_id', byEntryError, {
      companyId,
      journalEntryId: entryId,
    })
  } else if (releasedByEntry && releasedByEntry.length > 0) {
    // transactions has no write_audit_log trigger, so the clearing of the
    // link/categorization columns is logged here for incident reconstruction.
    log.info('Released bank transactions from reversed payment voucher', {
      companyId,
      journalEntryId: entryId,
      invoiceColumn,
      transactionIds: releasedByEntry.map((r) => (r as { id: string }).id),
    })
  }

  const txIds = paymentTransactionIds.filter((id): id is string => !!id)
  if (txIds.length > 0) {
    const { data: releasedById, error: byIdError } = await supabase
      .from('transactions')
      .update(resetFields)
      .eq('company_id', companyId)
      .in('id', txIds)
      .select('id')
    if (byIdError) {
      log.error('Failed to release transactions by payment transaction ids', byIdError, {
        companyId,
        journalEntryId: entryId,
        transactionIds: txIds,
      })
    } else if (releasedById && releasedById.length > 0) {
      log.info('Released payment-linked bank transactions from reversed voucher', {
        companyId,
        journalEntryId: entryId,
        invoiceColumn,
        transactionIds: releasedById.map((r) => (r as { id: string }).id),
      })
    }
  }
}
