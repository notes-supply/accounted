import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { reconstructReskontraAsOf } from './reskontra-payments'

export interface ARReconciliationResult {
  ar_ledger_total: number
  /**
   * Sum of posted balances on accounts 1510 (Kundfordringar) and 1513
   * (Kundfordringar: delad faktura). 1513 covers the Skatteverket portion
   * of ROT/RUT fakturamodellen invoices and is zero today (no fakturamodellen
   * postings yet): included for forward compatibility.
   */
  account_1510_balance: number
  difference: number
  is_reconciled: boolean
  /**
   * Number of foreign-currency invoices that lacked an exchange_rate, so their
   * outstanding amount could not be converted to SEK. When > 0 the difference
   * field may be misleading: any reported gap could be missing-data rather
   * than a true reconciliation break.
   */
  unconverted_fx_count: number
}
interface InvoiceForARReconciliation {
  id: string
  total: number | string | null
  paid_amount: number | string | null
  paid_at: string | null
  currency: string | null
  exchange_rate: number | string | null
  journal_entry_id: string | null
  credited_invoice_id: string | null
}

/**
 * Compare sum of open customer invoices against account 1510 balance.
 * Account 1510 is debit-normal (asset): balance = debits - credits.
 *
 * Conversion uses each invoice's stored exchange_rate (the invoice-date rate),
 * which matches what was originally posted to 1510. This means the report will
 * diverge from the GL once partial payments settle at a different rate (the
 * delta is correctly booked as valutakursvinst/-förlust to 3960/7960 per
 * ML 8 kap 21-23 §). A subledger-derived total would reconcile through that
 * difference; deferred to a follow-up.
 */
export async function generateARReconciliation(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  asOfDate?: string,
): Promise<ARReconciliationResult> {
  const invoices = await fetchAllRows<InvoiceForARReconciliation>(({ from, to }) => {
    let query = supabase
      .from('invoices')
      .select('id, total, paid_amount, paid_at, currency, exchange_rate, journal_entry_id, credited_invoice_id')
      .eq('company_id', companyId)
    query = asOfDate
      ? query.lte('invoice_date', asOfDate)
      : query.in('status', ['sent', 'overdue', 'partially_paid'])
    return query.order('id', { ascending: true }).range(from, to)
  })

  const reconstructed = asOfDate
    ? await reconstructReskontraAsOf(
        supabase,
        companyId,
        asOfDate,
        'invoice_payments',
        'invoice_id',
        invoices.map((invoice) => {
          const total = Number(invoice.total) || 0
          const paid = Number(invoice.paid_amount) || 0
          const isCredit = Boolean(invoice.credited_invoice_id) || total < 0
          return {
            id: invoice.id,
            total: Math.abs(total),
            liveOutstanding: Math.max(0, Math.abs(total) - Math.abs(paid)),
            paidAt: invoice.paid_at,
            sign: isCredit ? -1 : 1,
            registrationEvidence: 'required',
            registrationJournalEntryId: invoice.journal_entry_id,
          }
        }),
      )
    : null

  let unconvertedFxCount = 0
  const arLedgerTotal = invoices.reduce((sum, invoice) => {
    const total = Number(invoice.total) || 0
    const paid = Number(invoice.paid_amount) || 0
    const sign = invoice.credited_invoice_id || total < 0 ? -1 : 1
    const outstanding = reconstructed
      ? reconstructed.outstandingByInvoice.get(invoice.id)
      : Math.round(Math.max(0, Math.abs(total) - Math.abs(paid)) * sign * 100) / 100
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

  // Get AR receivable balance from the ledger in this period. We sum 1510
  // (Kundfordringar) AND 1513 (Kundfordringar: delad faktura) so the comparison
  // stays correct under ROT/RUT fakturamodellen, where the customer portion sits
  // on 1510 and the Skatteverket claim on 1513: both are open AR receivable
  // from the company's perspective. 1513 is zero today (no fakturamodellen
  // postings yet) so this is a forward-looking defense.
  //
  // We count posted AND reversed entries together: the SAME inclusion rule the
  // trial balance / balance sheet use. A corrected invoice flips its original to
  // status='reversed'; that reversed leg is cancelled by the posted storno, so
  // both must be summed or a corrected invoice manufactures a phantom gap.
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
    filterLines: (q: EntryLinesQuery) => q.in('account_number', ['1510', '1513']),
    attachEntriesAs: null,
  })

  // Both 1510 and 1513 are debit-normal assets: balance = debits - credits
  let account1510Balance = 0
  for (const line of journalLines) {
    account1510Balance = Math.round((account1510Balance + (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)) * 100) / 100
  }

  const difference = Math.round((arLedgerTotal - account1510Balance) * 100) / 100

  return {
    ar_ledger_total: Math.round(arLedgerTotal * 100) / 100,
    account_1510_balance: Math.round(account1510Balance * 100) / 100,
    difference,
    // BFL 5 kap requires the reconciliation to cover all affärshändelser. If
    // any row was excluded for a missing exchange rate, the calculation is
    // incomplete by construction and we cannot honestly stamp the period
    // Avstämd: the user must fix the underlying data first.
    is_reconciled: Math.abs(difference) < 0.01 && unconvertedFxCount === 0,
    unconverted_fx_count: unconvertedFxCount,
  }
}
