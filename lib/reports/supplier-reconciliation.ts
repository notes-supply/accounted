import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { reconstructReskontraAsOf } from './reskontra-payments'

export interface ReconciliationResult {
  supplier_ledger_total: number
  account_2440_balance: number
  difference: number
  is_reconciled: boolean
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * remaining_amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
}
interface SupplierInvoiceForReconciliation {
  id: string
  total: number | string | null
  remaining_amount: number | string | null
  paid_at: string | null
  currency: string | null
  exchange_rate: number | string | null
  is_credit_note: boolean
  registration_journal_entry_id: string | null
}

/**
 * Compare sum of open supplier invoices against account 2440 balance.
 *
 * Conversion uses each invoice's stored exchange_rate (the invoice-date rate),
 * which matches what was originally posted to 2440. This means the report will
 * diverge from the GL once partial payments settle at a different rate (the
 * delta is correctly booked as valutakursvinst/-förlust to 3960/7960 per
 * ML 8 kap 21-23 §). A subledger-derived total would reconcile through that
 * difference; deferred to a follow-up.
 */
export async function generateReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  asOfDate?: string,
): Promise<ReconciliationResult> {
  const invoices = await fetchAllRows<SupplierInvoiceForReconciliation>(({ from, to }) => {
    let query = supabase
      .from('supplier_invoices')
      .select(
        'id, total, remaining_amount, paid_at, currency, exchange_rate, is_credit_note, registration_journal_entry_id',
      )
      .eq('company_id', companyId)
    query = asOfDate
      ? query.lte('invoice_date', asOfDate)
      : query.in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
    return query.order('id', { ascending: true }).range(from, to)
  })

  const reconstructed = asOfDate
    ? await reconstructReskontraAsOf(
        supabase,
        companyId,
        asOfDate,
        'supplier_invoice_payments',
        'supplier_invoice_id',
        invoices.map((invoice) => ({
          id: invoice.id,
          total: Math.abs(Number(invoice.total) || 0),
          liveOutstanding: Math.abs(Number(invoice.remaining_amount) || 0),
          paidAt: invoice.paid_at,
          sign: invoice.is_credit_note ? -1 : 1,
          registrationEvidence: 'required',
          registrationJournalEntryId: invoice.registration_journal_entry_id,
        })),
      )
    : null

  let unconvertedFxCount = 0
  const supplierLedgerTotal = invoices.reduce((sum, invoice) => {
    const outstanding = reconstructed
      ? reconstructed.outstandingByInvoice.get(invoice.id)
      : Math.abs(Number(invoice.remaining_amount) || 0) * (invoice.is_credit_note ? -1 : 1)
    if (outstanding == null || outstanding === 0) return sum

    const isFx = invoice.currency != null && invoice.currency !== 'SEK'
    const hasRate = invoice.exchange_rate != null && Number(invoice.exchange_rate) > 0
    if (isFx && !hasRate) {
      unconvertedFxCount += 1
      return sum
    }
    return Math.round(
      (
        sum +
        resolveSekAmount(
          outstanding,
          null,
          invoice.currency,
          invoice.exchange_rate == null ? null : Number(invoice.exchange_rate),
        )
      ) * 100,
    ) / 100
  }, 0)

  // Get account 2440 balance from the ledger in this period. We count posted
  // AND reversed entries together: the SAME inclusion rule the trial balance /
  // balance sheet use. A corrected supplier invoice flips its original
  // registration to status='reversed' (storno-service.ts); that reversed credit
  // on 2440 is cancelled by the posted storno's debit, so BOTH legs must be
  // summed or the report double-counts the payment debit and shows a phantom
  // debit balance. (This is exactly the false −41 121,25 kr "Ej avstämd" gap a
  // fully-paid, fully-corrected company hit: posted-only = −41 121,25, but
  // posted+reversed = 0, matching the leverantörsreskontra.)
  // Fetched via the two-step entry-lines helper (entries first, then lines
  // chunked by entry id, both paginated): see lib/bookkeeping/entry-lines.ts.
  const journalLines = await fetchEntryLines<{
    id: string
    debit_amount: number | null
    credit_amount: number | null
  }>({
    supabase,
    lineColumns: 'id, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) => {
      let filtered = q
        .eq('company_id', companyId)
        .eq('fiscal_period_id', periodId)
        .in('status', ['posted', 'reversed'])
      if (asOfDate) {
        filtered = filtered
          .lte('entry_date', asOfDate)
          .lte('committed_at', `${asOfDate}T23:59:59.999Z`)
      }
      return filtered
    },
    filterLines: (q: EntryLinesQuery) => q.eq('account_number', '2440'),
    attachEntriesAs: null,
  })

  // Account 2440 is a liability: credit normal balance
  // Balance = credits - debits
  let account2440Balance = 0
  for (const line of journalLines) {
    account2440Balance = Math.round((account2440Balance + (Number(line.credit_amount) || 0) - (Number(line.debit_amount) || 0)) * 100) / 100
  }

  const difference = Math.round((supplierLedgerTotal - account2440Balance) * 100) / 100

  return {
    supplier_ledger_total: Math.round(supplierLedgerTotal * 100) / 100,
    account_2440_balance: Math.round(account2440Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    unconverted_fx_count: unconvertedFxCount,
  }
}
