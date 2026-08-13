/**
 * Kontantmetoden year-end cut-off (BFL 5 kap 2 §).
 *
 * Under kontantmetoden (bokslutsmetoden) affärshändelser are booked when cash
 * moves, so open customer and supplier invoices never reach 1510 / 2440 during
 * the year. BFL still requires that fordringar och skulder ARE booked at
 * räkenskapsårets utgång, so the year-end needs a cut-off entry that puts every
 * still-outstanding invoice onto the balance sheet.
 *
 * Moms is the part that is easy to get wrong. Under bokslutsmetoden moms is
 * reported at payment, so the cut-off must NOT push moms into the current
 * momsdeklaration. BAS provides "vilande" (dormant) moms accounts for exactly
 * this: 2618/2628/2638 for utgående and 2648 for ingående. They are absent from
 * ACCOUNT_RUTA / ACCOUNT_TO_BOX by design, so anything parked there stays out
 * of the declaration until the invoice is actually paid. Booking cut-off moms
 * to 2611/2641 instead would claim it a period early, which is the real error
 * this module exists to avoid.
 *
 * Shape: two aggregate verifikat (one for fordringar, one for skulder), each
 * reversed on the first day of the following period. Deliberately NOT
 * per-invoice, and deliberately not linked through invoices.journal_entry_id:
 *
 *  - the payment flows route on whether a live journal-entry link exists, so
 *    linking here would make every new-year payment take the accrual clearing
 *    path against a receivable the reversal has already removed, booking the
 *    settlement twice;
 *  - leaving the link unset means a new-year payment still books the normal
 *    kontantmetoden cash entry (revenue/expense + real moms at the payment
 *    date), which is what bokslutsmetoden requires.
 *
 * The reversal is what makes that safe: cut-off on the last day of the year,
 * vändning on the first day of the next, and the ledger is back to a pure cash
 * basis before any new-year payment is booked.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  JournalEntry,
  VatTreatment,
} from '@/types'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, reverseEntry } from '@/lib/bookkeeping/engine'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchPaymentTotalsByParent } from '@/lib/invoices/payment-totals'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'

const log = createLogger('kontantmetod-cutoff')
const SOURCE_ID_CHUNK_SIZE = 500
const CUSTOMER_DOCUMENT_SOURCE_TYPES = ['invoice_created', 'credit_note'] as const
const SUPPLIER_DOCUMENT_SOURCE_TYPES = [
  'supplier_invoice_registered',
  'supplier_invoice_cash_payment',
  'supplier_invoice_privately_paid',
  'supplier_credit_note',
] as const

/**
 * Vilande utgående moms per VAT treatment. Rates outside 25/12/6 (export,
 * reverse charge, exempt) carry no Swedish output moms at all, so they never
 * reach this map: their whole outstanding amount is revenue.
 */
export const VILANDE_OUTPUT_VAT_ACCOUNTS: Partial<Record<VatTreatment, string>> = {
  standard_25: '2618',
  reduced_12: '2628',
  reduced_6: '2638',
}

/** Vilande ingående moms. One account for every rate, mirroring 2641. */
export const VILANDE_INPUT_VAT_ACCOUNT = '2648'

export const RECEIVABLES_ACCOUNT = '1510'
export const PAYABLES_ACCOUNT = '2440'

/** A customer invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffReceivable {
  id: string
  /** Human reference for the line description. */
  reference: string
  vatTreatment: VatTreatment
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The moms share of `outstanding`. */
  vat: number
  /**
   * Net sales components in SEK. Mixed-rate invoices retain each frozen
   * revenue-account override and VAT treatment instead of collapsing to the
   * invoice header treatment. Omitted only for legacy single-rate callers.
   */
  netComponents?: Array<{
    treatment: VatTreatment
    account?: string | null
    amount: number
  }>
  /** Dormant output VAT components in SEK, one treatment per source rate. */
  vatComponents?: Array<{ treatment: VatTreatment; amount: number }>
}

/** A supplier invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffPayable {
  id: string
  reference: string
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The ingående moms share of `outstanding`. */
  vat: number
  /**
   * Omvänd betalningsskyldighet. The supplier charges no moms, so the buyer
   * self-assesses output AND input moms on 2614/2624/2634 + 2645/2647, which
   * is a symmetric pair that must never be split. `vat` is 0 on every such row
   * by construction, and this flag forces it to 0 anyway: routing a stray
   * amount into the single 2648 bucket would post a one-sided reverse charge,
   * the exact error the swedish-vat reference calls out as prohibited.
   * The self-assessed pair is handled by the payment entry after the vändning,
   * unchanged by the cut-off.
   */
  reverseCharge?: boolean
  /**
   * Net expense split across BAS accounts, as weights. Only the ratios matter:
   * the net total is always derived as `outstanding - vat` so the verifikat
   * balances no matter how the source rows round.
   */
  netByAccount: Array<{ account: string; amount: number }>
}

export interface CutoffLines {
  receivableLines: CreateJournalEntryLineInput[]
  payableLines: CreateJournalEntryLineInput[]
  receivableTotal: number
  payableTotal: number
}

// Go through roundOre first: Math.round(x * 100) alone mis-rounds exact-half
// values that arrive with float drift (lib/money.ts).
const toOre = (amount: number): number => Math.round(roundOre(amount) * 100)
const toKronor = (ore: number): number => ore / 100

/**
 * Split `totalOre` across `weights` so the parts sum to exactly `totalOre`.
 *
 * Proportional shares with largest-remainder allocation. Doing this in whole
 * öre (rather than rounding each share independently) is what keeps the
 * verifikat balanced: independent rounding drifts by an öre per bucket and the
 * DB balance trigger would reject the entry.
 */
export function distributeOre(totalOre: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (weights.length === 1) return [totalOre]

  const weightSum = weights.reduce((sum, w) => sum + Math.abs(w), 0)
  // Degenerate input (all-zero weights): put everything on the first bucket
  // rather than emitting NaN.
  if (weightSum === 0) return weights.map((_, i) => (i === 0 ? totalOre : 0))

  const exact = weights.map((w) => (Math.abs(w) / weightSum) * totalOre)
  const floors = exact.map((value) => Math.floor(value))
  let remainder = totalOre - floors.reduce((sum, value) => sum + value, 0)

  // Hand the leftover öre to the largest fractional parts first.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)

  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }
  return result
}

/** `distributeOre` for a signed accounting total. */
function distributeSignedOre(totalOre: number, weights: number[]): number[] {
  const sign = Math.sign(totalOre)
  return distributeOre(Math.abs(totalOre), weights).map((part) => part * sign)
}

/**
 * Build the cut-off verifikat lines. Pure: no IO, so the money math is
 * directly testable.
 *
 * Receivables: Debit 1510 / Credit 30xx + Credit 2618|2628|2638
 * Payables:    Debit 4-6xxx + Debit 2648 / Credit 2440
 */
export function buildCutoffLines(
  receivables: CutoffReceivable[],
  payables: CutoffPayable[],
  entityType: EntityType = 'aktiebolag',
): CutoffLines {
  const receivableLines: CreateJournalEntryLineInput[] = []
  const payableLines: CreateJournalEntryLineInput[] = []

  // ---- Fordringar -------------------------------------------------------
  // Group by resolved revenue account and dormant VAT treatment. Customer
  // invoices may contain several rates and frozen per-line account overrides.
  const revenueByAccount = new Map<string, number>()
  const outputVatByTreatment = new Map<VatTreatment, number>()
  let receivableOre = 0

  for (const row of receivables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    const vatOre = toOre(row.vat)
    const netOre = outstandingOre - vatOre

    receivableOre += outstandingOre
    const netComponents = row.netComponents ?? [{
      treatment: row.vatTreatment,
      amount: toKronor(netOre),
    }]
    for (const component of netComponents) {
      const amountOre = toOre(component.amount)
      if (amountOre === 0) continue
      const special = component.treatment === 'reverse_charge' || component.treatment === 'export'
      const account = !special && component.account
        ? component.account
        : getRevenueAccount(component.treatment, entityType)
      revenueByAccount.set(account, (revenueByAccount.get(account) ?? 0) + amountOre)
    }

    const vatComponents = row.vatComponents ?? (vatOre !== 0
      ? [{ treatment: row.vatTreatment, amount: toKronor(vatOre) }]
      : [])
    for (const component of vatComponents) {
      const amountOre = toOre(component.amount)
      if (amountOre === 0) continue
      outputVatByTreatment.set(
        component.treatment,
        (outputVatByTreatment.get(component.treatment) ?? 0) + amountOre,
      )
    }
  }

  if (receivableOre !== 0) {
    receivableLines.push({
      account_number: RECEIVABLES_ACCOUNT,
      debit_amount: receivableOre > 0 ? toKronor(receivableOre) : 0,
      credit_amount: receivableOre < 0 ? toKronor(-receivableOre) : 0,
      line_description: receivableOre > 0
        ? 'Kundfordringar vid räkenskapsårets utgång (kontantmetoden)'
        : 'Kundkreditsaldo vid räkenskapsårets utgång (kontantmetoden)',
    })

    for (const [account, netOre] of revenueByAccount) {
      if (netOre === 0) continue
      receivableLines.push({
        account_number: account,
        debit_amount: netOre < 0 ? toKronor(-netOre) : 0,
        credit_amount: netOre > 0 ? toKronor(netOre) : 0,
        line_description: 'Obetalda kundfakturor och kreditnotor vid bokslut',
      })
    }

    for (const [treatment, vatOre] of outputVatByTreatment) {
      if (vatOre === 0) continue
      const account = VILANDE_OUTPUT_VAT_ACCOUNTS[treatment]
      // No vilande account means the treatment carries no Swedish output moms
      // (export, omvänd betalningsskyldighet, undantagen). A non-zero moms
      // amount there is a data error: fold it into revenue rather than invent
      // a moms account, so the verifikat still balances and the anomaly shows
      // up as revenue rather than as a phantom momsskuld.
      if (!account) {
        log.warn('outstanding moms on a treatment with no vilande account; booked as revenue', {
          treatment,
          ore: vatOre,
        })
        receivableLines.push({
          account_number: getRevenueAccount(treatment, entityType),
          debit_amount: vatOre < 0 ? toKronor(-vatOre) : 0,
          credit_amount: vatOre > 0 ? toKronor(vatOre) : 0,
          line_description: 'Obetalda kundfakturor och kreditnotor vid bokslut',
        })
        continue
      }
      receivableLines.push({
        account_number: account,
        debit_amount: vatOre < 0 ? toKronor(-vatOre) : 0,
        credit_amount: vatOre > 0 ? toKronor(vatOre) : 0,
        line_description: 'Vilande utgående moms, redovisas vid betalning',
      })
    }
  }

  // ---- Skulder ----------------------------------------------------------
  const expenseByAccount = new Map<string, number>()
  let payableOre = 0
  let inputVatOre = 0

  for (const row of payables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    // Reverse charge carries no deductible moms on the invoice itself: the
    // self-assessed pair is booked by the payment entry, never split into the
    // single vilande bucket. Forced to 0 rather than trusted from the row.
    const vatOre = row.reverseCharge ? 0 : toOre(row.vat)
    const netOre = outstandingOre - vatOre

    payableOre += outstandingOre
    inputVatOre += vatOre

    const buckets = row.netByAccount.length > 0
      ? row.netByAccount
      // No item detail: park the net on the generic övriga kostnader account
      // rather than dropping it. The entry is reversed the next day, so the
      // account choice never survives into the new year.
      : [{ account: '6990', amount: 1 }]
    const shares = distributeSignedOre(netOre, buckets.map((b) => b.amount))
    buckets.forEach((bucket, index) => {
      const share = shares[index]
      if (share === 0) return
      expenseByAccount.set(bucket.account, (expenseByAccount.get(bucket.account) ?? 0) + share)
    })
  }

  for (const [account, netOre] of expenseByAccount) {
    if (netOre === 0) continue
    payableLines.push({
      account_number: account,
      debit_amount: netOre > 0 ? toKronor(netOre) : 0,
      credit_amount: netOre < 0 ? toKronor(-netOre) : 0,
      line_description: 'Obetalda leverantörsfakturor och kreditnotor vid bokslut',
    })
  }

  if (inputVatOre !== 0) {
    payableLines.push({
      account_number: VILANDE_INPUT_VAT_ACCOUNT,
      debit_amount: inputVatOre > 0 ? toKronor(inputVatOre) : 0,
      credit_amount: inputVatOre < 0 ? toKronor(-inputVatOre) : 0,
      line_description: 'Vilande ingående moms, dras av vid betalning',
    })
  }

  if (payableOre !== 0) {
    payableLines.push({
      account_number: PAYABLES_ACCOUNT,
      debit_amount: payableOre < 0 ? toKronor(-payableOre) : 0,
      credit_amount: payableOre > 0 ? toKronor(payableOre) : 0,
      line_description: payableOre > 0
        ? 'Leverantörsskulder vid räkenskapsårets utgång (kontantmetoden)'
        : 'Leverantörsfordran vid räkenskapsårets utgång (kontantmetoden)',
    })
  }

  return {
    receivableLines,
    payableLines,
    receivableTotal: toKronor(receivableOre),
    payableTotal: toKronor(payableOre),
  }
}

/** Swap every debit and credit: the vändning posted on day 1 of the new year. */
export function reverseLines(
  lines: CreateJournalEntryLineInput[],
): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({
    ...line,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: `Vändning: ${line.line_description ?? ''}`.trim(),
  }))
}

/** The day after `date`, ISO. Used to date the vändning. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export interface CutoffCollection {
  receivables: CutoffReceivable[]
  payables: CutoffPayable[]
  /**
   * Invoices whose vat_treatment is missing. Never guessed at: a reduced-rate
   * or exempt invoice silently defaulted to 25 % would land on the wrong
   * vilande account and the wrong revenue account. Posting refuses while this
   * is non-empty so the user fixes the source rows instead.
   */
  unknownVatTreatment: string[]
  /**
   * Invoices carrying moms on a treatment that cannot have Swedish output moms
   * (export, omvänd betalningsskyldighet, undantagen). Absorbing that into the
   * revenue line would balance the verifikat while silently swallowing a real
   * invoicing error, which is the netting the swedish-vat reference prohibits.
   * Excluded and refused on the same footing as a missing treatment.
   */
  strayVatOnZeroRate: string[]
}

/**
 * An aggregate verifikat still has to say which affärshändelser it covers
 * (BFL 5 kap 6-7 §: motpart and underlag must be traceable). The lines are
 * grouped by account, so the invoice references go into the entry `notes`
 * where an examiner can follow them back to the sub-ledger.
 *
 * Truncated past a sane length: the note is a pointer to the reskontra, not a
 * replacement for it, and an unbounded note on a company with thousands of
 * open invoices helps nobody.
 */
export function buildCutoffNote(label: string, references: string[]): string {
  const named = references.filter((ref) => ref && ref.trim().length > 0)
  if (named.length === 0) return `${label}: inga fakturanummer registrerade`
  const MAX = 50
  const shown = named.slice(0, MAX).join(', ')
  const rest = named.length - Math.min(named.length, MAX)
  return rest > 0
    ? `${label} (${named.length} st): ${shown} och ${rest} till. ` +
        'Fullständig specifikation finns i reskontran per bokslutsdagen.'
    : `${label} (${named.length} st): ${shown}`
}

type CustomerInvoiceItemRow = {
  sort_order?: number | null
  line_type?: string | null
  line_total?: number | null
  vat_rate?: number | null
  vat_amount?: number | null
  revenue_account?: string | null
}

type SupplierInvoiceItemRow = {
  sort_order?: number | null
  account_number?: string | null
  line_total?: number | null
}

function itemTreatment(rate: number, invoiceTreatment: VatTreatment): VatTreatment {
  return rate === 0 && (invoiceTreatment === 'reverse_charge' || invoiceTreatment === 'export')
    ? invoiceTreatment
    : getVatTreatmentForRate(rate)
}

function buildReceivableComponents(
  items: CustomerInvoiceItemRow[],
  invoiceTreatment: VatTreatment,
  netOre: number,
  vatOre: number,
  originalItems?: CustomerInvoiceItemRow[],
): Pick<CutoffReceivable, 'netComponents' | 'vatComponents'> {
  const productItems = items.filter((item) => item.line_type !== 'text')
  if (productItems.length === 0) return {}

  const originalAccounts = new Map(
    (originalItems ?? [])
      .filter((item) => item.sort_order != null && item.revenue_account)
      .map((item) => [item.sort_order as number, item.revenue_account as string]),
  )
  const netShares = distributeSignedOre(
    netOre,
    productItems.map((item) => Math.abs(Number(item.line_total ?? 0))),
  )
  const vatShares = distributeSignedOre(
    vatOre,
    productItems.map((item) => Math.abs(Number(item.vat_amount ?? 0))),
  )

  const netComponents = productItems.map((item, index) => ({
    treatment: itemTreatment(Number(item.vat_rate ?? 0), invoiceTreatment),
    account: item.revenue_account ?? originalAccounts.get(Number(item.sort_order)) ?? null,
    amount: toKronor(netShares[index]),
  }))
  const vatComponents = productItems
    .map((item, index) => ({
      treatment: itemTreatment(Number(item.vat_rate ?? 0), invoiceTreatment),
      amount: toKronor(vatShares[index]),
    }))
    .filter((component) => component.amount !== 0)

  return { netComponents, vatComponents }
}

type JournalLineageRow = {
  id: string
  source_id: string | null
  source_type: string | null
  status: string
  entry_date: string
  correction_of_id: string | null
  reverses_id: string | null
  committed_at: string | null
}

type SupplierPaymentRow = {
  id: string
  supplier_invoice_id: string
  payment_date: string
  amount: number | string
  journal_entry_id: string | null
}

type JournalLineage = {
  correctionsByParent: Map<string, JournalLineageRow[]>
  reversalsByParent: Map<string, JournalLineageRow[]>
}

const JOURNAL_LINEAGE_COLUMNS =
  'id, source_id, source_type, status, entry_date, correction_of_id, reverses_id, committed_at'

function assertCommittedLineageEntry(entry: JournalLineageRow): void {
  if (!entry.id || !entry.entry_date) {
    throw new Error(
      `Could not prove journal lineage for entry ${entry.id || '<missing id>'}`,
    )
  }
  if (entry.status !== 'posted' && entry.status !== 'reversed') {
    throw new Error(
      `Unexpected journal lineage status ${entry.status} for entry ${entry.id}`,
    )
  }
}

async function fetchLineageChildren(
  supabase: SupabaseClient,
  companyId: string,
  parentIds: string[],
): Promise<{ corrections: JournalLineageRow[]; reversals: JournalLineageRow[] }> {
  const corrections: JournalLineageRow[] = []
  const reversals: JournalLineageRow[] = []
  const uniqueIds = Array.from(new Set(parentIds))

  for (let i = 0; i < uniqueIds.length; i += SOURCE_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SOURCE_ID_CHUNK_SIZE)
    const [correctionRows, reversalRows] = await Promise.all([
      fetchAllRows<JournalLineageRow>(({ from, to }) =>
        supabase
          .from('journal_entries')
          .select(JOURNAL_LINEAGE_COLUMNS)
          .eq('company_id', companyId)
          .eq('source_type', 'correction')
          .in('status', ['posted', 'reversed'])
          .in('correction_of_id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<JournalLineageRow>(({ from, to }) =>
        supabase
          .from('journal_entries')
          .select(JOURNAL_LINEAGE_COLUMNS)
          .eq('company_id', companyId)
          .eq('source_type', 'storno')
          .eq('status', 'posted')
          .in('reverses_id', chunk)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
    corrections.push(...correctionRows)
    reversals.push(...reversalRows)
  }

  return { corrections, reversals }
}

async function fetchJournalLineage(
  supabase: SupabaseClient,
  companyId: string,
  roots: JournalLineageRow[],
): Promise<JournalLineage> {
  const correctionsByParent = new Map<string, JournalLineageRow[]>()
  const reversalsByParent = new Map<string, JournalLineageRow[]>()
  let frontier = roots
    .filter((entry) => entry.status === 'reversed')
    .map((entry) => entry.id)
  const expanded = new Set<string>()

  while (frontier.length > 0) {
    const parentIds = frontier.filter((id) => !expanded.has(id))
    if (parentIds.length === 0) break
    parentIds.forEach((id) => expanded.add(id))

    const { corrections, reversals } = await fetchLineageChildren(
      supabase,
      companyId,
      parentIds,
    )
    for (const child of corrections) {
      if (!child.correction_of_id) {
        throw new Error(`Correction ${child.id} has no correction_of_id`)
      }
      const siblings = correctionsByParent.get(child.correction_of_id) ?? []
      siblings.push(child)
      correctionsByParent.set(child.correction_of_id, siblings)
    }
    for (const child of reversals) {
      if (!child.reverses_id) {
        throw new Error(`Storno ${child.id} has no reverses_id`)
      }
      const siblings = reversalsByParent.get(child.reverses_id) ?? []
      siblings.push(child)
      reversalsByParent.set(child.reverses_id, siblings)
    }
    frontier = corrections
      .filter((entry) => entry.status === 'reversed')
      .map((entry) => entry.id)
  }

  return { correctionsByParent, reversalsByParent }
}

function hasLiveEffectAtCutoff(
  entry: JournalLineageRow,
  lineage: JournalLineage,
  periodEnd: string,
  visiting: Set<string> = new Set(),
): boolean {
  assertCommittedLineageEntry(entry)
  if (entry.status === 'posted') return entry.entry_date <= periodEnd
  if (visiting.has(entry.id)) {
    throw new Error(`Cyclic journal lineage at entry ${entry.id}`)
  }

  const nextVisiting = new Set(visiting)
  nextVisiting.add(entry.id)
  const corrections = lineage.correctionsByParent.get(entry.id) ?? []
  const reversals = lineage.reversalsByParent.get(entry.id) ?? []

  if (corrections.length > 1) {
    throw new Error(`Ambiguous correction lineage for entry ${entry.id}`)
  }
  if (reversals.length !== 1) {
    throw new Error(`Could not resolve storno lineage for entry ${entry.id}`)
  }

  const reversal = reversals[0]
  assertCommittedLineageEntry(reversal)
  if (
    reversal.source_type !== 'storno' ||
    reversal.reverses_id !== entry.id ||
    reversal.status !== 'posted'
  ) {
    throw new Error(`Malformed storno lineage for entry ${entry.id}`)
  }

  const correction = corrections[0]
  if (!correction) {
    // A plain storno removes only an effect that had started by the cutoff.
    // Posting it later does not turn this accounting-date report into a
    // transaction-time snapshot.
    return entry.entry_date <= periodEnd && reversal.entry_date > periodEnd
  }

  assertCommittedLineageEntry(correction)
  if (
    correction.source_type !== 'correction' ||
    correction.correction_of_id !== entry.id ||
    reversal.entry_date !== entry.entry_date
  ) {
    throw new Error(`Malformed correction lineage for entry ${entry.id}`)
  }

  // Traverse first even when the immediate replacement is future-dated: that
  // child may itself have been corrected back into the cutoff period. If no
  // descendant has a live effect yet, the parent remains represented until
  // the immediate replacement's accounting date.
  if (hasLiveEffectAtCutoff(correction, lineage, periodEnd, nextVisiting)) {
    return true
  }
  return correction.entry_date > periodEnd && entry.entry_date <= periodEnd
}

async function fetchJournalEntriesByIds(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<Map<string, JournalLineageRow>> {
  const entries = new Map<string, JournalLineageRow>()
  const uniqueIds = Array.from(new Set(entryIds))

  for (let i = 0; i < uniqueIds.length; i += SOURCE_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SOURCE_ID_CHUNK_SIZE)
    const rows = await fetchAllRows<JournalLineageRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select(JOURNAL_LINEAGE_COLUMNS)
        .eq('company_id', companyId)
        .in('id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const entry of rows) entries.set(entry.id, entry)
  }

  const unresolved = uniqueIds.filter((id) => !entries.has(id))
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve ${unresolved.length} supplier payment journal entries`,
    )
  }
  return entries
}

async function fetchSupplierPaymentVoucherRoots(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceIds: string[],
): Promise<JournalLineageRow[]> {
  const roots: JournalLineageRow[] = []
  const uniqueIds = Array.from(new Set(supplierInvoiceIds))

  for (let i = 0; i < uniqueIds.length; i += SOURCE_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SOURCE_ID_CHUNK_SIZE)
    const rows = await fetchAllRows<JournalLineageRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select(JOURNAL_LINEAGE_COLUMNS)
        .eq('company_id', companyId)
        .eq('source_type', 'supplier_invoice_paid')
        .in('status', ['posted', 'reversed'])
        .in('source_id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    roots.push(...rows)
  }

  return roots
}

async function fetchSupplierPaymentTotalsAtCutoff(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceIds: string[],
  periodEnd: string,
): Promise<Map<string, number>> {
  const payments: SupplierPaymentRow[] = []
  const uniqueIds = Array.from(new Set(supplierInvoiceIds))

  for (let i = 0; i < uniqueIds.length; i += SOURCE_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SOURCE_ID_CHUNK_SIZE)
    const rows = await fetchAllRows<SupplierPaymentRow>(({ from, to }) =>
      supabase
        .from('supplier_invoice_payments')
        .select('id, supplier_invoice_id, payment_date, amount, journal_entry_id')
        .eq('company_id', companyId)
        .lte('payment_date', periodEnd)
        .in('supplier_invoice_id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    payments.push(...rows)
  }

  const linkedIds = payments.flatMap((payment) =>
    payment.journal_entry_id ? [payment.journal_entry_id] : []
  )
  const [linkedRoots, paymentVoucherRoots] = await Promise.all([
    linkedIds.length > 0
      ? fetchJournalEntriesByIds(supabase, companyId, linkedIds)
      : Promise.resolve(new Map<string, JournalLineageRow>()),
    fetchSupplierPaymentVoucherRoots(supabase, companyId, supplierInvoiceIds),
  ])
  const allRoots = new Map(linkedRoots)
  for (const root of paymentVoucherRoots) allRoots.set(root.id, root)
  const lineage = allRoots.size > 0
    ? await fetchJournalLineage(
      supabase,
      companyId,
      Array.from(allRoots.values()),
    )
    : { correctionsByParent: new Map(), reversalsByParent: new Map() }

  const totals = new Map<string, number>()
  const durablePaymentLinks = new Set<string>()
  for (const payment of payments) {
    if (payment.journal_entry_id) {
      durablePaymentLinks.add(
        `${payment.journal_entry_id}:${payment.supplier_invoice_id}`,
      )
    }
    // The column has been nullable since supplier_invoice_payments was
    // introduced. Early mark-paid flows could legitimately write a row after
    // the journal helper returned null, so an unlinked row remains a documented
    // compatibility case. Every non-null link must resolve and prove a live
    // company-scoped ledger effect.
    const countsAtCutoff = payment.journal_entry_id === null ||
      hasLiveEffectAtCutoff(
        linkedRoots.get(payment.journal_entry_id)!,
        lineage,
        periodEnd,
      )
    if (!countsAtCutoff) continue
    totals.set(
      payment.supplier_invoice_id,
      (totals.get(payment.supplier_invoice_id) ?? 0) + Number(payment.amount),
    )
  }

  for (const root of paymentVoucherRoots) {
    if (
      root.source_id &&
      hasLiveEffectAtCutoff(root, lineage, periodEnd) &&
      !durablePaymentLinks.has(`${root.id}:${root.source_id}`)
    ) {
      // Successful plain-reversal cleanup deletes this row. The immutable
      // voucher proves a payment existed, but custom and FX payment vouchers
      // make its invoice-currency amount impossible to reconstruct exactly
      // from balancing totals. Refuse the cutoff instead of guessing.
      throw new Error(
        `Missing supplier payment history for live journal entry ${root.id}`,
      )
    }
  }
  return totals
}

async function fetchPostedSourceLiveness(
  supabase: SupabaseClient,
  companyId: string,
  sourceIds: string[],
  sourceTypes: readonly string[],
  periodEnd: string,
): Promise<{ live: Set<string>; reversedByCutoff: Set<string> }> {
  const roots: JournalLineageRow[] = []
  const uniqueIds = Array.from(new Set(sourceIds))

  for (let i = 0; i < uniqueIds.length; i += SOURCE_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SOURCE_ID_CHUNK_SIZE)
    const entries = await fetchAllRows<JournalLineageRow>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select(JOURNAL_LINEAGE_COLUMNS)
        .eq('company_id', companyId)
        .in('source_type', [...sourceTypes])
        .in('status', ['posted', 'reversed'])
        .in('source_id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    roots.push(...entries)
  }

  const lineage = await fetchJournalLineage(
    supabase,
    companyId,
    roots,
  )
  const live = new Set<string>()
  const reversedByCutoff = new Set<string>()
  for (const entry of roots) {
    if (!entry.source_id) continue
    if (hasLiveEffectAtCutoff(entry, lineage, periodEnd)) {
      live.add(entry.source_id)
    } else if (entry.status === 'reversed' && entry.entry_date <= periodEnd) {
      // A source voucher that started by the cutoff and whose exact storno
      // lineage removed it by then proves the document was no longer live.
      // Future-dated source vouchers do not prove historical cancellation.
      reversedByCutoff.add(entry.source_id)
    }
  }
  return { live, reversedByCutoff }
}

/**
 * Fetch every invoice still outstanding at `periodEnd`.
 *
 * "Outstanding at period end" is deliberately payment-DATE based, not the
 * current remaining_amount: an invoice settled in January was still a
 * fordran on 31 December and must be part of the cut-off. Reading
 * remaining_amount would silently shrink the cut-off every day the user
 * delays running the bokslut.
 */
export async function collectKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CutoffCollection> {
  const [invoices, supplierInvoices] = await Promise.all([
    fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, vat_treatment, credited_invoice_id, document_type, items:invoice_items(sort_order, line_type, line_total, vat_rate, vat_amount, revenue_account)')
        .eq('company_id', companyId)
        .lte('invoice_date', periodEnd)
        .in('status', ['sent', 'overdue', 'partially_paid', 'paid', 'credited'])
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, status, reversed_at, total, total_sek, vat_amount, vat_amount_sek, reverse_charge, is_credit_note, credited_invoice_id, items:supplier_invoice_items(sort_order, account_number, line_total)')
        .eq('company_id', companyId)
        .lte('invoice_date', periodEnd)
        .in('status', ['registered', 'approved', 'partially_paid', 'paid', 'overdue', 'credited', 'disputed', 'reversed'])
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  const invoiceIds = invoices.map((row) => row.id as string)
  const supplierIds = supplierInvoices.map((row) => row.id as string)
  // Resolve document-source vouchers first. A supplier document already
  // represented in the ledger is not a cash-cutoff candidate, so its missing
  // or legacy payment evidence must not block reconstruction of unrelated
  // invoices.
  const [invoiceSourceLiveness, supplierSourceLiveness] = await Promise.all([
    fetchPostedSourceLiveness(
      supabase,
      companyId,
      invoiceIds,
      CUSTOMER_DOCUMENT_SOURCE_TYPES,
      periodEnd,
    ),
    fetchPostedSourceLiveness(
      supabase,
      companyId,
      supplierIds,
      SUPPLIER_DOCUMENT_SOURCE_TYPES,
      periodEnd,
    ),
  ])
  const bookedInvoiceSourceIds = invoiceSourceLiveness.live
  const bookedSupplierSourceIds = supplierSourceLiveness.live
  const supplierPaymentCandidateIds = supplierInvoices
    .filter((row) =>
      !bookedSupplierSourceIds.has(row.id as string) &&
      Number(row.total ?? 0) !== 0
    )
    .map((row) => row.id as string)

  // Payments ON OR BEFORE period end reduce the remaining cash-cutoff
  // candidates; later payments do not.
  const [paidByInvoice, paidBySupplierInvoice] = await Promise.all([
    fetchPaymentTotalsByParent({
      supabase,
      table: 'invoice_payments',
      parentColumn: 'invoice_id',
      companyId,
      parentIds: invoiceIds,
      throughDate: periodEnd,
    }),
    fetchSupplierPaymentTotalsAtCutoff(
      supabase,
      companyId,
      supplierPaymentCandidateIds,
      periodEnd,
    ),
  ])

  const invoicesById = new Map(invoices.map((row) => [row.id as string, row]))

  const receivables: CutoffReceivable[] = []
  const unknownVatTreatment: string[] = []
  const strayVatOnZeroRate: string[] = []
  for (const row of invoices) {
    const documentType = row.document_type as string | null
    if (documentType && documentType !== 'invoice') continue

    const id = row.id as string
    const creditedInvoiceId = row.credited_invoice_id as string | null
    // Source vouchers by the selected date already represent the document in
    // the ledger. Current row pointers are deliberately ignored because they
    // may refer to a voucher posted after this historical cutoff.
    if (bookedInvoiceSourceIds.has(id)) continue

    const invoiceTotal = Number(row.total ?? 0)
    const totalSek = Number(row.total_sek ?? row.total ?? 0)
    const vatSek = Number(row.vat_amount_sek ?? row.vat_amount ?? 0)
    const paid = paidByInvoice.get(id) ?? 0
    const outstandingInInvoiceCurrency = roundOre(invoiceTotal - paid)
    const ratio = invoiceTotal === 0 ? 0 : outstandingInInvoiceCurrency / invoiceTotal
    const outstanding = roundOre(totalSek * ratio)
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    // Never guess the treatment. Defaulting a 12 %/6 %/undantagen invoice to
    // 25 % would route it to the wrong vilande account AND the wrong revenue
    // account; the moms impact is deferred but the year-end fordran
    // composition would be wrong on the balance sheet. Collect and refuse.
    const treatment = row.vat_treatment as VatTreatment | null
    const reference = (row.invoice_number as string) ?? ''
    if (!treatment) {
      unknownVatTreatment.push(reference || id)
      continue
    }

    const scaledVat = roundOre(vatSek * ratio)
    const items = (row.items ?? []) as CustomerInvoiceItemRow[]
    const originalItems = creditedInvoiceId
      ? (invoicesById.get(creditedInvoiceId)?.items ?? []) as CustomerInvoiceItemRow[]
      : undefined
    const components = buildReceivableComponents(
      items,
      treatment,
      toOre(outstanding) - toOre(scaledVat),
      toOre(scaledVat),
      originalItems,
    )

    // Validate each effective item treatment. A mixed invoice may have a
    // domestic header but still contain zero-rate lines, so header-only checks
    // are insufficient.
    const invalidVat = components.vatComponents?.some((component) =>
      !VILANDE_OUTPUT_VAT_ACCOUNTS[component.treatment] &&
      Math.abs(component.amount) >= ORE_TOLERANCE,
    ) ?? (!VILANDE_OUTPUT_VAT_ACCOUNTS[treatment] && Math.abs(scaledVat) >= ORE_TOLERANCE)
    if (invalidVat) {
      strayVatOnZeroRate.push(reference || id)
      continue
    }

    receivables.push({
      id,
      reference,
      vatTreatment: treatment,
      outstanding,
      vat: scaledVat,
      ...components,
    })
  }

  const supplierInvoicesById = new Map(
    supplierInvoices.map((row) => [row.id as string, row]),
  )
  const payables: CutoffPayable[] = []
  for (const row of supplierInvoices) {
    const id = row.id as string
    if (bookedSupplierSourceIds.has(id)) continue
    if (row.status === 'reversed') {
      const reversedAt = typeof row.reversed_at === 'string'
        ? row.reversed_at.slice(0, 10)
        : null
      if (
        supplierSourceLiveness.reversedByCutoff.has(id)
        || (reversedAt !== null && reversedAt <= periodEnd)
      ) {
        continue
      }
    }


    const isCreditNote = Boolean(row.is_credit_note)
    const invoiceMagnitude = Math.abs(Number(row.total ?? 0))
    const totalSekMagnitude = Math.abs(Number(row.total_sek ?? row.total ?? 0))
    const vatSekMagnitude = Math.abs(Number(row.vat_amount_sek ?? row.vat_amount ?? 0))
    const documentSign = isCreditNote ? -1 : Math.sign(Number(row.total ?? 0)) || 1
    const paid = paidBySupplierInvoice.get(id) ?? 0
    const outstandingMagnitude = roundOre(invoiceMagnitude - paid)
    const ratio = invoiceMagnitude === 0 ? 0 : outstandingMagnitude / invoiceMagnitude
    const outstanding = roundOre(documentSign * totalSekMagnitude * ratio)
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    const vat = roundOre(documentSign * vatSekMagnitude * ratio)
    const items = (row.items ?? []) as SupplierInvoiceItemRow[]
    const creditedInvoiceId = row.credited_invoice_id as string | null
    const originalItems = creditedInvoiceId
      ? (supplierInvoicesById.get(creditedInvoiceId)?.items ?? []) as SupplierInvoiceItemRow[]
      : []
    const originalAccounts = new Map(
      originalItems
        .filter((item) => item.sort_order != null && item.account_number)
        .map((item) => [item.sort_order as number, item.account_number as string]),
    )
    const effectiveItems = items.length > 0 ? items : originalItems
    payables.push({
      id,
      reference: (row.supplier_invoice_number as string) ?? '',
      outstanding,
      vat,
      reverseCharge: Boolean(row.reverse_charge),
      netByAccount: effectiveItems
        .map((item) => ({
          account: item.account_number ??
            originalAccounts.get(Number(item.sort_order)) ??
            '',
          amount: Math.abs(Number(item.line_total ?? 0)),
        }))
        .filter((item) => item.account),
    })
  }

  log.info('collected kontantmetoden cut-off', {
    companyId,
    periodStart,
    periodEnd,
    receivables: receivables.length,
    payables: payables.length,
  })

  if (unknownVatTreatment.length > 0) {
    log.warn('invoices without vat_treatment excluded from the cut-off', {
      companyId,
      count: unknownVatTreatment.length,
    })
  }
  if (strayVatOnZeroRate.length > 0) {
    log.warn('invoices with moms on a zero-rate treatment excluded from the cut-off', {
      companyId,
      count: strayVatOnZeroRate.length,
    })
  }

  return { receivables, payables, unknownVatTreatment, strayVatOnZeroRate }
}

export interface PostCutoffResult {
  receivableEntry: JournalEntry | null
  receivableReversal: JournalEntry | null
  payableEntry: JournalEntry | null
  payableReversal: JournalEntry | null
}

/**
 * Assert the vändning can actually be posted BEFORE any cut-off entry exists.
 *
 * The cut-off and its reversal are two verifikat, and the engine gives no
 * cross-entry transaction: if the reversal fails after the cut-off is
 * committed, 1510/2440 stay permanently inflated and every new-year payment
 * double-books. Checking the target period up front turns the common failure
 * (next period missing, closed, or locked) into a refusal that posts nothing,
 * which leaves the compensating storno below as a genuine last resort rather
 * than the expected path.
 */
async function assertReversalPeriodPostable(
  supabase: SupabaseClient,
  companyId: string,
  nextFiscalPeriodId: string,
  reversalDate: string,
): Promise<void> {
  if (!nextFiscalPeriodId) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kräver att nästa räkenskapsår är upplagt: vändningen bokas första dagen på det nya året.',
    )
  }

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed, locked_at')
    .eq('id', nextFiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(
      'Kontantmetodens bokslutsavgränsning kräver att nästa räkenskapsår är upplagt: vändningen bokas första dagen på det nya året.',
    )
  }
  if (data.is_closed || data.locked_at) {
    throw new Error(
      'Nästa räkenskapsår är stängt eller låst: vändningen av bokslutsavgränsningen kan inte bokföras. Lås upp perioden och försök igen.',
    )
  }
  if (reversalDate < (data.period_start as string) || reversalDate > (data.period_end as string)) {
    throw new Error(
      `Vändningsdatumet ${reversalDate} ligger utanför nästa räkenskapsår: kontrollera periodernas datum.`,
    )
  }
}

/**
 * Post the cut-off verifikat and their vändningar.
 *
 * Refuses outright unless the vändning can be posted (see
 * assertReversalPeriodPostable) and unless every invoice has a known
 * vat_treatment: a cut-off without its vändning leaves 1510/2440 permanently
 * inflated and makes every new-year payment double-book.
 *
 * If a reversal still fails after its cut-off committed, the cut-off is
 * stornoed through the sanctioned reverseEntry() path (BFL 5 kap 5 §: posted
 * entries are never edited or deleted) so the ledger is left consistent, and
 * the original error is rethrown.
 */
export async function postKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: {
    fiscalPeriodId: string
    nextFiscalPeriodId: string
    periodEnd: string
    receivables: CutoffReceivable[]
    payables: CutoffPayable[]
    entityType?: EntityType
    /** Refuse if any invoice lacked a vat_treatment (see CutoffCollection). */
    unknownVatTreatment?: string[]
    /** Refuse if any invoice carried moms on a zero-rate treatment. */
    strayVatOnZeroRate?: string[]
  },
): Promise<PostCutoffResult> {
  if (opts.unknownVatTreatment && opts.unknownVatTreatment.length > 0) {
    throw new Error(
      `${opts.unknownVatTreatment.length} fakturor saknar momsinställning och kan inte tas med i bokslutsavgränsningen: ` +
        `${opts.unknownVatTreatment.slice(0, 10).join(', ')}. Komplettera fakturorna och kör om.`,
    )
  }

  if (opts.strayVatOnZeroRate && opts.strayVatOnZeroRate.length > 0) {
    throw new Error(
      `${opts.strayVatOnZeroRate.length} fakturor har moms trots en momsfri momsinställning (export, omvänd betalningsskyldighet eller undantagen) och kan inte tas med i bokslutsavgränsningen: ` +
        `${opts.strayVatOnZeroRate.slice(0, 10).join(', ')}. Rätta fakturorna och kör om.`,
    )
  }

  const { receivableLines, payableLines } = buildCutoffLines(
    opts.receivables,
    opts.payables,
    opts.entityType,
  )
  const reversalDate = nextDay(opts.periodEnd)

  const result: PostCutoffResult = {
    receivableEntry: null,
    receivableReversal: null,
    payableEntry: null,
    payableReversal: null,
  }

  if (receivableLines.length === 0 && payableLines.length === 0) return result

  await assertReversalPeriodPostable(supabase, companyId, opts.nextFiscalPeriodId, reversalDate)

  /**
   * Post a cut-off/vändning pair. On reversal failure the cut-off is stornoed
   * so the pair is all-or-nothing from the ledger's point of view.
   */
  const postPair = async (
    lines: CreateJournalEntryLineInput[],
    label: string,
    references: string[],
  ): Promise<[JournalEntry, JournalEntry]> => {
    const entry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.fiscalPeriodId,
      entry_date: opts.periodEnd,
      description: `${label} vid bokslut (kontantmetoden)`,
      source_type: 'year_end',
      notes: buildCutoffNote(label, references),
      lines,
    })

    try {
      const reversal = await createJournalEntry(supabase, companyId, userId, {
        fiscal_period_id: opts.nextFiscalPeriodId,
        entry_date: reversalDate,
        description: `Vändning ${label.toLowerCase()} bokslut (kontantmetoden)`,
        source_type: 'year_end',
        notes: buildCutoffNote(`Vändning ${label.toLowerCase()}`, references),
        lines: reverseLines(lines),
      })
      return [entry, reversal]
    } catch (reversalError) {
      // Compensate: an un-reversed cut-off is worse than no cut-off at all.
      try {
        // Storno in the same period as the cut-off so the pair nets to zero
        // inside the year being closed.
        await reverseEntry(supabase, companyId, userId, entry.id, opts.periodEnd)
      } catch (stornoError) {
        log.error(
          'cut-off reversal failed AND the compensating storno failed: 1510/2440 left inflated, manual correction required',
          stornoError as Error,
          { companyId, entryId: entry.id },
        )
      }
      throw reversalError
    }
  }

  if (receivableLines.length > 0) {
    const [entry, reversal] = await postPair(
      receivableLines,
      'Kundfordringar',
      opts.receivables.map((r) => r.reference),
    )
    result.receivableEntry = entry
    result.receivableReversal = reversal
  }

  if (payableLines.length > 0) {
    const [entry, reversal] = await postPair(
      payableLines,
      'Leverantörsskulder',
      opts.payables.map((p) => p.reference),
    )
    result.payableEntry = entry
    result.payableReversal = reversal
  }

  return result
}
