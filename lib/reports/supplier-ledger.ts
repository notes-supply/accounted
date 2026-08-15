import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { reconstructReskontraAsOf, todayIsoDate, type ReskontraAsOf } from './reskontra-payments'

export interface SupplierLedgerEntry {
  supplier_id: string
  supplier_name: string
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export interface SupplierLedgerReport {
  entries: SupplierLedgerEntry[]
  total_outstanding: number
  total_current: number
  total_overdue: number
  unpaid_count: number
  /**
   * Number of foreign-currency invoices excluded from the SEK totals because
   * they had no exchange_rate. Adding them would mix currencies; surfacing
   * the count lets the UI tell the user a row could not be converted.
   */
  unconverted_fx_count: number
}
interface SupplierLedgerInvoiceRow {
  id: string
  supplier_id: string
  supplier: { id: string; name: string } | null
  invoice_date: string
  due_date: string
  status: string
  total: number | string | null
  remaining_amount: number | string | null
  paid_at: string | null
  currency: string | null
  exchange_rate: number | string | null
  is_credit_note: boolean
  registration_journal_entry_id?: string | null
}

/**
 * Generate supplier ledger (leverantörsreskontra) with aging analysis.
 *
 * With a backdated `asOfDate` the ledger is reconstructed as it stood on that
 * date: invoices dated on or before it (including ones fully paid since) with
 * outstanding amounts recomputed from the payment history (#1021). Without an
 * `asOfDate`, or with today/future, the live open-invoice state is used as-is.
 */
export async function generateSupplierLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<SupplierLedgerReport> {
  const refDate = asOfDate ? new Date(asOfDate) : new Date()
  // Backdated reconstruction only for genuinely historical dates: for
  // today/future the stored open-invoice state IS the as-of state.
  const isHistorical = !!asOfDate && asOfDate < todayIsoDate()

  // Historical population is intentionally status-independent: current
  // credited/reversed state cannot decide whether the document existed at the
  // selected cutoff. Immutable registration lineage decides below.
  let invoices: SupplierLedgerInvoiceRow[]
  let reconstruction: ReskontraAsOf | null = null
  try {
    invoices = await fetchAllRows<SupplierLedgerInvoiceRow>(({ from, to }) => {
      let query = supabase
        .from('supplier_invoices')
        .select('*, supplier:suppliers(id, name)')
        .eq('company_id', companyId)
      query = isHistorical
        ? query.lte('invoice_date', asOfDate!)
        : query.in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      return query
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to)
    })

    if (isHistorical) {
      reconstruction = await reconstructReskontraAsOf(
        supabase,
        companyId,
        asOfDate!,
        'supplier_invoice_payments',
        'supplier_invoice_id',
        invoices.map((invoice) => ({
          id: invoice.id,
          total: Math.abs(Number(invoice.total) || 0),
          liveOutstanding: Math.abs(Number(invoice.remaining_amount) || 0),
          paidAt: invoice.paid_at,
          sign: invoice.is_credit_note ? -1 : 1,
          registrationEvidence: Object.prototype.hasOwnProperty.call(
            invoice,
            'registration_journal_entry_id',
          )
            ? 'required'
            : 'optional',
          registrationJournalEntryId: invoice.registration_journal_entry_id,
        })),
      )
    }
  } catch {
    return {
      entries: [],
      total_outstanding: 0,
      total_current: 0,
      total_overdue: 0,
      unpaid_count: 0,
      unconverted_fx_count: 0,
    }
  }

  // Group by supplier and calculate aging
  const bySupplier = new Map<string, SupplierLedgerEntry>()
  let unconvertedFxCount = 0
  let unpaidCount = 0

  for (const inv of invoices) {
    const supplierId = inv.supplier_id
    const supplierName = inv.supplier?.name || 'Okänd leverantör'

    // Foreign-currency invoice with no exchange_rate cannot be converted to
    // SEK; adding the raw foreign amount to a SEK total would be unsound, so
    // the row is excluded from sums and only counted.
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    if (isFx && !hasRate) {
      unconvertedFxCount += 1
      continue
    }

    const liveOutstanding =
      Math.abs(Number(inv.remaining_amount) || 0) * (inv.is_credit_note ? -1 : 1)
    const outstandingRaw = reconstruction && inv.id
      ? reconstruction.outstandingByInvoice.get(inv.id)
      : liveOutstanding

    // Missing means the immutable registration was not economically effective
    // at this cutoff. Zero means it was already settled by then.
    if (outstandingRaw == null || outstandingRaw === 0) continue
    unpaidCount += 1

    if (!bySupplier.has(supplierId)) {
      bySupplier.set(supplierId, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
      })
    }

    const entry = bySupplier.get(supplierId)!
    const dueDate = new Date(inv.due_date)
    const daysOverdue = Math.floor((refDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    // Outstanding is in invoice currency. The 2440 GL line was posted in SEK
    // at the invoice-date rate, so we convert here for the reconciliation.
    const amount = resolveSekAmount(
      outstandingRaw,
      null,
      inv.currency,
      inv.exchange_rate == null ? null : Number(inv.exchange_rate),
    )

    if (daysOverdue <= 0) {
      entry.current += amount
    } else if (daysOverdue <= 30) {
      entry.days_1_30 += amount
    } else if (daysOverdue <= 60) {
      entry.days_31_60 += amount
    } else if (daysOverdue <= 90) {
      entry.days_61_90 += amount
    } else {
      entry.days_90_plus += amount
    }

    entry.total_outstanding += amount
  }

  const entries = Array.from(bySupplier.values())
    .sort((a, b) => b.total_outstanding - a.total_outstanding)

  const total_outstanding = entries.reduce((sum, e) => sum + e.total_outstanding, 0)
  const total_current = entries.reduce((sum, e) => sum + e.current, 0)
  const total_overdue = total_outstanding - total_current

  return {
    entries,
    total_outstanding: Math.round(total_outstanding * 100) / 100,
    total_current: Math.round(total_current * 100) / 100,
    total_overdue: Math.round(total_overdue * 100) / 100,
    unpaid_count: isHistorical ? unpaidCount : invoices.length,
    unconverted_fx_count: unconvertedFxCount,
  }
}
