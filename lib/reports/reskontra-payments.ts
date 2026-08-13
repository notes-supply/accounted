import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'

/**
 * Payment history for reconstructing a reskontra as of an arbitrary date.
 *
 * `paidThrough` sums the payment rows dated on or before the as-of date, per
 * invoice. `hasRows` marks invoices that have ANY payment rows (any date):
 * callers need it to tell "paid, but after the as-of date" (reconstructable,
 * paid-through 0) apart from "no payment rows recorded at all" (legacy data,
 * fall back to the invoice's own paid_at / stored amounts).
 */
export interface PaymentsAsOf {
  paidThrough: Map<string, number>
  hasRows: Set<string>
}

interface PaymentRow {
  id: string
  amount: number | string | null
  payment_date: string
}

interface SupplierPaymentRow extends PaymentRow {
  journal_entry_id: string | null
  reversed_at: string | null
  reversed_by_journal_entry_id: string | null
}

interface ReversalJournalRow {
  id: string
  entry_date: string
  status: string
  source_type: string | null
  reverses_id: string | null
}

const JOURNAL_ID_CHUNK_SIZE = 100

/**
 * Fetch the company's payment rows for one of the two invoice ledgers and
 * aggregate them per invoice as of `asOfDate` (inclusive). Amounts are in the
 * invoice's own currency, matching how the ledger generators convert to SEK
 * with the invoice-date exchange_rate.
 */
export async function fetchPaymentsAsOf(
  supabase: SupabaseClient,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  invoiceIdColumn: 'invoice_id' | 'supplier_invoice_id',
  companyId: string,
  asOfDate: string
): Promise<PaymentsAsOf> {
  const isSupplierLedger = table === 'supplier_invoice_payments'
  let rows: Array<PaymentRow & Record<string, unknown>>
  if (isSupplierLedger) {
    rows = await fetchAllRows<SupplierPaymentRow & Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('supplier_invoice_payments')
        .select(
          'supplier_invoice_id, id, amount, payment_date, journal_entry_id, reversed_at, reversed_by_journal_entry_id',
        )
        .eq('company_id', companyId)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to),
    )
  } else {
    rows = await fetchAllRows<PaymentRow & Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('invoice_payments')
        .select('invoice_id, id, amount, payment_date')
        .eq('company_id', companyId)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to),
    )
  }

  const reversals = new Map<string, ReversalJournalRow>()
  if (isSupplierLedger) {
    const reversalIds = new Set<string>()
    for (const rawRow of rows) {
      const row = rawRow as SupplierPaymentRow & Record<string, unknown>
      const hasReversalTimestamp = row.reversed_at !== null
      const hasReversalLink = row.reversed_by_journal_entry_id !== null
      if (hasReversalTimestamp !== hasReversalLink) {
        throw new Error(`Malformed supplier payment reversal metadata for ${row.id}`)
      }
      if (hasReversalLink) {
        if (!row.journal_entry_id) {
          throw new Error(`Missing original journal lineage for supplier payment ${row.id}`)
        }
        reversalIds.add(row.reversed_by_journal_entry_id as string)
      }
    }

    const uniqueIds = Array.from(reversalIds)
    for (let i = 0; i < uniqueIds.length; i += JOURNAL_ID_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + JOURNAL_ID_CHUNK_SIZE)
      const journalRows = await fetchAllRows<ReversalJournalRow>(({ from, to }) =>
        supabase
          .from('journal_entries')
          .select('id, entry_date, status, source_type, reverses_id')
          .eq('company_id', companyId)
          .in('id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      )
      for (const journalRow of journalRows) reversals.set(journalRow.id, journalRow)
    }

    const unresolved = uniqueIds.filter((id) => !reversals.has(id))
    if (unresolved.length > 0) {
      throw new Error(
        `Could not resolve ${unresolved.length} supplier payment reversal journal entries`,
      )
    }
  }

  const paidThrough = new Map<string, number>()
  const hasRows = new Set<string>()

  for (const rawRow of rows) {
    const invoiceId = rawRow[invoiceIdColumn] as string | null
    if (!invoiceId) continue
    hasRows.add(invoiceId)

    let liveAtCutoff = true
    if (isSupplierLedger) {
      const row = rawRow as SupplierPaymentRow & Record<string, unknown>
      if (row.reversed_by_journal_entry_id) {
        const reversal = reversals.get(row.reversed_by_journal_entry_id)
        if (
          !reversal ||
          !reversal.entry_date ||
          reversal.status !== 'posted' ||
          reversal.source_type !== 'storno' ||
          reversal.reverses_id !== row.journal_entry_id
        ) {
          throw new Error(`Malformed supplier payment reversal lineage for ${row.id}`)
        }
        liveAtCutoff = reversal.entry_date > asOfDate
      }
    }

    if (liveAtCutoff && rawRow.payment_date && rawRow.payment_date <= asOfDate) {
      const prev = paidThrough.get(invoiceId) ?? 0
      paidThrough.set(invoiceId, roundOre(prev + (Number(rawRow.amount) || 0)))
    }
  }

  return { paidThrough, hasRows }
}

/**
 * An invoice's outstanding amount (in invoice currency) as of the
 * reconstruction date.
 *
 * Priority order:
 * 1. Payment rows exist: they are authoritative. Outstanding is the invoice
 *    total minus the rows dated on or before the as-of date, including the
 *    "all payments came later" case, which reopens the full total.
 * 2. No rows but the invoice is fully paid (`paid_at` set): paid before or on
 *    the as-of date means the live (settled) outstanding stands; paid after
 *    it means the full total was still open.
 * 3. No rows and no `paid_at` (legacy partial payments recorded before the
 *    payment tables carried every settlement): the history cannot be dated,
 *    so the live outstanding is assumed to have stood at the as-of date.
 *    This matches what the live ledger reports for the same rows.
 */
export function outstandingAsOf(
  invoice: { id: string; paid_at?: string | null },
  total: number,
  liveOutstanding: number,
  payments: PaymentsAsOf,
  asOfDate: string
): number {
  if (payments.hasRows.has(invoice.id)) {
    const paid = payments.paidThrough.get(invoice.id) ?? 0
    return roundOre(total - paid)
  }
  if (invoice.paid_at) {
    return String(invoice.paid_at).slice(0, 10) <= asOfDate ? liveOutstanding : total
  }
  return liveOutstanding
}

/** Local calendar date (YYYY-MM-DD) used to decide whether an as-of date needs
 * historical reconstruction at all. */
export function todayIsoDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
