import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  VatDeclaration,
  VatDeclarationRutor,
  VatPeriodType,
} from '@/types'
import type { VatCheckAccountTotals } from './vat-declaration-checks'
import { rcBasisTotalsByRate } from './vat-filing-gate'
import { fetchDynamicRuta05Accounts } from './vat-revenue-accounts'
import { parseVatPeriodInput } from '@/lib/vat/period-input'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Reads posted journal entry lines for the period. Static BAS mappings cover
 * ordinary VAT and revenue accounts. Account 2648 is the deliberate exception:
 * only app-created cash-method year-end cutoff entries and their verified
 * reversals contribute, because arbitrary dormant input VAT is not deductible.
 */

/**
 * Account-to-ruta mapping for the Swedish momsdeklaration (SKV 4700).
 *
 * Pure ledger projection: every Ruta on the SKV 4700 form maps to one or more
 * BAS account balances aggregated over the period. The mapping below follows
 * the BAS 2026 chart and Skatteverket's published BAS-to-Ruta spec
 * (`.claude/skills/swedish-vat/references/vat-compliance-reference.md` §7).
 *
 * Output VAT (261x/262x/263x) → ruta 10/11/12 per rate (credit balance)
 *   Includes parent/summary accounts (2610/2620/2630) for users who post
 *   directly to the group account, and vilande accounts (2618/2628/2638)
 *   used by cash-method bookkeepers for invoices not yet paid.
 * Reverse charge output (2614/2624/2634) → ruta 30/31/32 (credit)
 * Import VAT (2615/2625/2635) → ruta 60/61/62 (credit)
 * Statically deductible input VAT accounts → ruta 48 (debit), incl. parent 2640
 *   Account 2648 is source-aware and deliberately absent from this map.
 * Domestic taxable sales (3000-3003) → ruta 05 (credit)
 *   The company's OWN class 3 accounts marked with a moms-sats join ruta 05 on
 *   top of this fixed list: see fetchDynamicRuta05Accounts (#1261). This map
 *   only covers the accounts Accounted itself seeds.
 * Uttag (3401-3403) → ruta 06 (credit)
 * EU goods (3108) → ruta 35; EU services (3308) → ruta 39 (credit)
 * Export (3105/3305) → ruta 36/40; Exempt (3004/3100/3404/3994/3980) → ruta 42 (credit)
 * Reverse-charge purchase bases: read from the cost account the journal
 * entry posted to (debit balance), not from supplier classification:
 *   4515/4516/4517 (EU goods 25/12/6%) → ruta 20
 *   4535/4536/4537 (EU services 25/12/6%) → ruta 21
 *   4531/4532/4533 (non-EU services 25/12/6%) → ruta 22
 *   4415/4416/4417 (domestic goods reverse charge) → ruta 23
 *   4425/4426/4427 (domestic services reverse charge) → ruta 24
 *   4545/4546/4547 (import) → ruta 50
 */
export const ACCOUNT_RUTA: Record<string, { box: keyof VatDeclarationRutor; side: 'credit' | 'debit' }> = {
  // Output VAT 25% → ruta 10
  '2610': { box: 'ruta10', side: 'credit' },  // Utgående moms 25% (summary/parent)
  '2611': { box: 'ruta10', side: 'credit' },  // Försäljning inom Sverige
  '2612': { box: 'ruta10', side: 'credit' },  // Egna uttag
  '2613': { box: 'ruta10', side: 'credit' },  // Uthyrning (frivillig skattskyldighet)
  '2616': { box: 'ruta10', side: 'credit' },  // Vinstmarginalbeskattning
  '2618': { box: 'ruta10', side: 'credit' },  // Vilande utgående moms 25%
  // Output VAT 12% → ruta 11
  '2620': { box: 'ruta11', side: 'credit' },  // Utgående moms 12% (summary/parent)
  '2621': { box: 'ruta11', side: 'credit' },
  '2622': { box: 'ruta11', side: 'credit' },  // Egna uttag
  '2623': { box: 'ruta11', side: 'credit' },  // Uthyrning
  '2626': { box: 'ruta11', side: 'credit' },  // VMB
  '2628': { box: 'ruta11', side: 'credit' },  // Vilande utgående moms 12%
  // Output VAT 6% → ruta 12
  '2630': { box: 'ruta12', side: 'credit' },  // Utgående moms 6% (summary/parent)
  '2631': { box: 'ruta12', side: 'credit' },
  '2632': { box: 'ruta12', side: 'credit' },  // Egna uttag
  '2633': { box: 'ruta12', side: 'credit' },  // Uthyrning
  '2636': { box: 'ruta12', side: 'credit' },  // VMB
  '2638': { box: 'ruta12', side: 'credit' },  // Vilande utgående moms 6%
  // Reverse charge output VAT → ruta 30/31/32
  '2614': { box: 'ruta30', side: 'credit' },
  '2624': { box: 'ruta31', side: 'credit' },
  '2634': { box: 'ruta32', side: 'credit' },
  // Input VAT → ruta 48
  '2640': { box: 'ruta48', side: 'debit' },   // Ingående moms (summary/parent)
  '2641': { box: 'ruta48', side: 'debit' },   // Debiterad ingående moms
  '2642': { box: 'ruta48', side: 'debit' },   // Frivillig skattskyldighet
  '2645': { box: 'ruta48', side: 'debit' },   // Förvärv utlandet (EU/non-EU RC)
  '2646': { box: 'ruta48', side: 'debit' },   // Uthyrning
  '2647': { box: 'ruta48', side: 'debit' },   // Omvänd skattskyldighet i Sverige
  '2649': { box: 'ruta48', side: 'debit' },   // Blandad verksamhet
  // Import VAT (since 2015, via momsdeklaration) → ruta 60/61/62
  '2615': { box: 'ruta60', side: 'credit' },  // Import 25%
  '2625': { box: 'ruta61', side: 'credit' },  // Import 12%
  '2635': { box: 'ruta62', side: 'credit' },  // Import 6%
  // Revenue: domestic taxable sales → ruta 05
  '3000': { box: 'ruta05', side: 'credit' },  // Försäljning inom Sverige (summary/parent)
  '3001': { box: 'ruta05', side: 'credit' },
  '3002': { box: 'ruta05', side: 'credit' },
  '3003': { box: 'ruta05', side: 'credit' },
  // Revenue: momspliktiga uttag → ruta 06
  '3401': { box: 'ruta06', side: 'credit' },
  '3402': { box: 'ruta06', side: 'credit' },
  '3403': { box: 'ruta06', side: 'credit' },
  // Revenue: EU goods/services → ruta 35/39
  '3108': { box: 'ruta35', side: 'credit' },  // Varuförsäljning till EU
  '3308': { box: 'ruta39', side: 'credit' },  // Tjänsteförsäljning till EU
  // Revenue: export/other → ruta 36/40/42
  '3105': { box: 'ruta36', side: 'credit' },  // Varuförsäljning export
  '3305': { box: 'ruta40', side: 'credit' },  // Tjänsteförsäljning export
  '3004': { box: 'ruta42', side: 'credit' },  // Momsfri försäljning (AB)
  '3100': { box: 'ruta42', side: 'credit' },  // Momsfria intäkter (EF)
  '3404': { box: 'ruta42', side: 'credit' },  // Momsfria uttag
  '3980': { box: 'ruta42', side: 'credit' },  // Erhållna offentliga stöd m.m.
  '3994': { box: 'ruta42', side: 'credit' },  // Övriga rörelseintäkter momsfria
  // Revenue: omvänd skattskyldighet inom Sverige → ruta 41. The seller books
  // NO output VAT (the buyer accounts for it via rutor 23-24/30-32), so these
  // deliberately stay OUT of the ruta 05-08 vs 10-12 pairing checks.
  '3231': { box: 'ruta41', side: 'credit' },  // Försäljning byggsektorn, omvänd betalningsskyldighet
  '3232': { box: 'ruta41', side: 'credit' },  // Omvänd betalningsskyldighet, övriga (skrot m.m.)
  '3233': { box: 'ruta41', side: 'credit' },  // Omvänd betalningsskyldighet, övriga
  // Reverse-charge purchase bases (debit on cost accounts) → ruta 20-24, 50
  '4515': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 25%
  '4516': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 12%
  '4517': { box: 'ruta20', side: 'debit' },   // Inköp varor EU 6%
  '4535': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 25%
  '4536': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 12%
  '4537': { box: 'ruta21', side: 'debit' },   // Inköp tjänster EU 6%
  '4531': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 25%
  '4532': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 12%
  '4533': { box: 'ruta22', side: 'debit' },   // Inköp tjänster utanför EU 6%
  '4415': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 25%
  '4416': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 12%
  '4417': { box: 'ruta23', side: 'debit' },   // Inköp varor SE reverse charge 6%
  '4425': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 25%
  '4426': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 12%
  '4427': { box: 'ruta24', side: 'debit' },   // Inköp tjänster SE reverse charge 6%
  '4545': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 25%
  '4546': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 12%
  '4547': { box: 'ruta50', side: 'debit' },   // Beskattningsunderlag import 6%
}

/**
 * Private projection key for the verified 2648 exception. It is intentionally
 * not a BAS account and never appears in ACCOUNT_RUTA, VAT_ACCOUNTS, or the
 * exported input-account list.
 */
const CONTROLLED_CUTOFF_INPUT_VAT_KEY = '__controlled_cash_method_cutoff_input_vat__'
const RUTA_PROJECTION: Record<string, {
  box: keyof VatDeclarationRutor
  side: 'credit' | 'debit'
}> = {
  ...ACCOUNT_RUTA,
  [CONTROLLED_CUTOFF_INPUT_VAT_KEY]: { box: 'ruta48', side: 'debit' },
}

const VAT_ACCOUNTS = Object.keys(ACCOUNT_RUTA)

/**
 * 26xx output VAT accounts feeding rutor 10/11/12, 30/31/32 and 60/61/62.
 * Derived from ACCOUNT_RUTA so the KPI vatLiability widget can never drift
 * from the momsdeklaration (ruta 49) calculation.
 */
export const VAT_OUTPUT_ACCOUNTS = Object.entries(ACCOUNT_RUTA)
  .filter(([account, mapping]) => account.startsWith('26') && mapping.side === 'credit')
  .map(([account]) => account)

/** Statically mapped input VAT accounts feeding ruta 48. */
export const VAT_INPUT_ACCOUNTS = Object.entries(ACCOUNT_RUTA)
  .filter(([, mapping]) => mapping.box === 'ruta48')
  .map(([account]) => account)

/**
 * The reverse-charge INPUT VAT accounts the momsdeklaration completeness check
 * compares rutor 30-32 against: 2645 (beräknad ingående moms på förvärv från
 * utlandet, EU and non-EU) and 2647 (ingående moms, omvänd betalningsskyldighet
 * i Sverige). The other five statically mapped ruta 48 accounts are not
 * reverse charge and stay out, especially 2649 (mixed activities): counting
 * them would reintroduce the aggregation the sharpened check exists to remove.
 *
 * Mirrors RC_INPUT_ACCOUNTS in ./vat-declaration-checks, which keeps its copy
 * private. The two lists are pinned together behaviourally in
 * __tests__/vat-declaration.test.ts: it feeds the projected pair and a full
 * totals map carrying a balance on every OTHER ruta 48 account to
 * runVatDeclarationChecks and asserts identical findings, so widening the list
 * on one side without the other fails there.
 */
export const RC_INPUT_VAT_ACCOUNTS = ['2645', '2647'] as const

/**
 * Calculate period start and end dates
 */
export function calculatePeriodDates(
  periodType: VatPeriodType,
  year: number,
  period: number
): { start: string; end: string } {
  const validated = parseVatPeriodInput({ periodType, year, period })
  let startMonth: number
  let endMonth: number

  switch (validated.periodType) {
    case 'monthly':
      // period is 1-12
      startMonth = validated.period
      endMonth = validated.period
      break
    case 'quarterly':
      // period is 1-4
      startMonth = (validated.period - 1) * 3 + 1
      endMonth = validated.period * 3
      break
    case 'yearly':
      // period is 1
      startMonth = 1
      endMonth = 12
      break
    default:
      startMonth = 1
      endMonth = 12
  }

  const startDate = new Date(validated.year, startMonth - 1, 1)
  const endDate = new Date(validated.year, endMonth, 0) // Last day of end month

  return {
    start: formatDate(startDate),
    end: formatDate(endDate),
  }
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Round to 2 decimal places
 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Resolve the start/end dates for a VAT period.
 *
 * Monthly and quarterly VAT periods are always calendar months/quarters
 * (kalendermånad / kalenderkvartal per SFL 26 kap), so they use the plain
 * calendar calculation.
 *
 * Annual VAT (helårsmoms), however, is reported per *räkenskapsår* (the
 * beskattningsår), not per calendar year (SFL 26 kap 10-11 §§). A räkenskapsår
 * can be extended or shortened (up to 18 months for a first/changed year per
 * BFL 3 kap 3 §), so a calendar Jan-Dec span would silently drop part of an
 * extended year (e.g. a first year 2025-07-03 → 2026-12-31). When the caller
 * supplies the fiscal period we therefore use its actual bounds. Annual VAT
 * fails closed when the fiscal period cannot be resolved: a calendar fallback
 * can silently report the wrong broken fiscal year.
 */
export async function resolvePeriodDates(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriodId?: string
): Promise<{
  start: string
  end: string
  fiscalPeriodId?: string
  fiscalPeriodStart?: string
  fiscalPeriodEnd?: string
}> {
  const validated = parseVatPeriodInput({ periodType, year, period })
  let dates: { start: string; end: string } | null = null
  let resolvedFiscalPeriodId: string | undefined
  let fiscalPeriodBounds: { start: string; end: string } | undefined
  if (validated.periodType === 'yearly') {
    if (fiscalPeriodId) {
      const { data: fp, error: fiscalPeriodError } = await supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (fiscalPeriodError) {
        throw new Error(`Failed to resolve annual fiscal period: ${fiscalPeriodError.message}`)
      }
      if (!fp?.period_start || !fp?.period_end) {
        throw new Error(`No fiscal period found for id ${fiscalPeriodId}`)
      }
      if (fp.period_end.slice(0, 4) !== String(validated.year)) {
        throw new Error(`Fiscal period ${fiscalPeriodId} does not end in ${validated.year}`)
      }
      dates = { start: fp.period_start, end: fp.period_end }
      fiscalPeriodBounds = dates
      resolvedFiscalPeriodId = fiscalPeriodId
    } else {
      // No explicit fiscal period: resolve the räkenskapsår ending in `year`
      // instead of assuming a calendar FY. Helårsmoms is filed per
      // räkenskapsår (SFL 26 kap 10-11 §§), so for a broken fiscal year the
      // calendar-year assumption would put both the redovisningsperiod and
      // the figures on the wrong period. For calendar-FY companies this
      // resolves to Jan-Dec of `year`, identical to the arithmetic fallback.
      const { data: fiscalPeriodRows, error: fiscalPeriodError } = await supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end')
        .eq('company_id', companyId)
        .gte('period_end', `${validated.year}-01-01`)
        .lte('period_end', `${validated.year}-12-31`)
        .order('period_end', { ascending: false })
        .limit(2)
      if (fiscalPeriodError) {
        throw new Error(`Failed to resolve annual fiscal period: ${fiscalPeriodError.message}`)
      }
      // Supabase returns an array here. The object normalization keeps older
      // unit-test doubles compatible while production still checks two rows.
      const fiscalPeriods = Array.isArray(fiscalPeriodRows)
        ? fiscalPeriodRows
        : fiscalPeriodRows ? [fiscalPeriodRows] : []
      if (fiscalPeriods.length > 1) {
        throw new Error(
          `Multiple fiscal periods end in ${validated.year}; fiscal_period_id is required`,
        )
      }
      const fp = fiscalPeriods[0]
      if (!fp?.period_start || !fp?.period_end) {
        throw new Error(`No fiscal period found ending in ${validated.year}`)
      }
      dates = { start: fp.period_start, end: fp.period_end }
      fiscalPeriodBounds = dates
      resolvedFiscalPeriodId = fp.id as string
    }
  }
  dates ??= calculatePeriodDates(validated.periodType, validated.year, validated.period)

  const boundedDates = await applyVatLiabilityBoundary(supabase, companyId, dates)
  return {
    ...boundedDates,
    ...(resolvedFiscalPeriodId ? { fiscalPeriodId: resolvedFiscalPeriodId } : {}),
    ...(fiscalPeriodBounds ? {
      fiscalPeriodStart: fiscalPeriodBounds.start,
      fiscalPeriodEnd: fiscalPeriodBounds.end,
    } : {}),
  }
}

/** Apply the legal VAT-liability boundary to an already resolved period. */
export async function applyVatLiabilityBoundary(
  supabase: SupabaseClient,
  companyId: string,
  dates: { start: string; end: string },
): Promise<{ start: string; end: string }> {

  // The first VAT period may start after the fiscal period itself. This is
  // common for newly registered companies, including retroactive decisions.
  // Clamp only the period containing the liability start: later periods retain
  // their ordinary bounds, while ledger activity before VAT liability never
  // leaks into the first declaration.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('vat_liability_start_date')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) {
    throw new Error(`Failed to resolve VAT liability start: ${settingsError.message}`)
  }
  const vatStart = settings?.vat_liability_start_date as string | null | undefined
  return applyVatLiabilityStartBoundary(dates, vatStart ?? null)
}

/** Apply one already-validated VAT-liability identity without another read. */
export function applyVatLiabilityStartBoundary(
  dates: { start: string; end: string },
  vatStart: string | null,
): { start: string; end: string } {
  if (vatStart && dates.end < vatStart) {
    throw new Error(`Requested VAT period ends before VAT liability starts on ${vatStart}`)
  }
  if (vatStart && vatStart >= dates.start && vatStart <= dates.end) {
    return { start: vatStart, end: dates.end }
  }

  return dates
}

/**
 * Accounts a momsredovisning settles the period's net against: 2650
 * (Redovisningskonto för moms, att betala) and 1650 (Momsfordran, att återfå).
 * Mirrors VAT_SETTLEMENT_ACCOUNT/VAT_REFUND_ACCOUNT in vat-settlement.ts,
 * which imports from this module and therefore cannot be imported here.
 */
export const VAT_SETTLEMENT_NET_ACCOUNTS = ['2650', '1650']

/** A momsredovisning entry detected by shape rather than source_type. */
export interface VatSettlementShapedEntry {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  voucher_series: string | null
  voucher_number: number | null
}

export interface VatAccountTotals {
  totals: Map<string, { debit: number; credit: number }>
  /**
   * Untagged momsredovisning entries found in the period (manual vouchers,
   * SIE-imported settlements, stornos of a settlement). Already excluded
   * from `totals`; surfaced so the settlement proposal can warn and gate.
   */
  settlementShapedEntries: VatSettlementShapedEntry[]
  /**
   * Posted/reversed entry counts per source_type for the whole period,
   * INCLUDING tagged vat_settlement entries (they never match the
   * invoice/transaction buckets, and the metadata scan always counted them).
   * Comes back in the same RPC round trip so the declaration metadata no
   * longer needs its own paginated entry scan.
   */
  sourceTypeCounts: Record<string, number>
}

/** Wire shape of the get_vat_declaration_totals RPC jsonb payload. */
interface VatTotalsRpcPayload {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  settlement_shaped_entries: VatSettlementShapedEntry[]
  source_type_counts: Record<string, number>
}

const CUTOFF_PAYABLE_DESCRIPTION = 'Leverantörsskulder vid bokslut (kontantmetoden)'
const CUTOFF_PAYABLE_REVERSAL_DESCRIPTION =
  'Vändning leverantörsskulder bokslut (kontantmetoden)'

interface ControlledCutoffLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

interface ControlledCutoffRelatedEntry {
  id: string
  company_id: string
  status: string
  entry_date: string
  description: string
  source_type: string | null
  source_id: string | null
  correction_of_id: string | null
  reverses_id: string | null
  reversed_by_id: string | null
  lines: ControlledCutoffLine[] | null
}

interface ControlledCutoffLineageRow {
  root_id: string
  parent_id: string | null
  edge_kind: 'root' | 'correction' | 'storno'
  id: string
  entry_date: string
  status: string
  source_type: string | null
  correction_of_id: string | null
  reverses_id: string | null
  depth: number
  path: string[]
  cycle: boolean
}

interface ControlledCutoffLineage {
  entries: Map<string, ControlledCutoffRelatedEntry>
  correctionsByParent: Map<string, ControlledCutoffRelatedEntry[]>
  reversalsByParent: Map<string, ControlledCutoffRelatedEntry[]>
}

const CONTROLLED_CUTOFF_MAX_DEPTH = 32
const CONTROLLED_CUTOFF_MAX_ENTRIES = 20_000
const CONTROLLED_CUTOFF_ID_BATCH_SIZE = 100
// Same 65-row maximum valid chain as supplier payment lineage. 300 roots
// leave 500 rows of headroom under the RPC's 20,000 emitted-row limit.
const CONTROLLED_CUTOFF_ROOT_BATCH_SIZE = 300
function shiftedIsoDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function lineEffectKey(
  line: ControlledCutoffLine,
  reverse: boolean,
): string | null {
  const debit = Number(reverse ? line.credit_amount : line.debit_amount)
  const credit = Number(reverse ? line.debit_amount : line.credit_amount)
  if (
    !line.account_number
    || !Number.isFinite(debit)
    || !Number.isFinite(credit)
    || debit < 0
    || credit < 0
    || (debit === 0) === (credit === 0)
  ) {
    return null
  }
  return JSON.stringify([
    line.account_number,
    Math.round(debit * 100),
    Math.round(credit * 100),
  ])
}

/**
 * Compare complete line multiplicities, not just the 2648 balance. A forged
 * reverses_id with an unrelated balancing entry must not inherit cutoff status.
 */
function hasExactReversedEffect(
  original: ControlledCutoffLine[] | null,
  reversal: ControlledCutoffLine[] | null,
): boolean {
  if (!original?.length || !reversal?.length || original.length !== reversal.length) {
    return false
  }

  const expected = new Map<string, number>()
  for (const line of original) {
    const key = lineEffectKey(line, true)
    if (!key) return false
    expected.set(key, (expected.get(key) ?? 0) + 1)
  }
  for (const line of reversal) {
    const key = lineEffectKey(line, false)
    const remaining = key ? expected.get(key) : undefined
    if (!key || !remaining) return false
    if (remaining === 1) expected.delete(key)
    else expected.set(key, remaining - 1)
  }
  return expected.size === 0
}

function hasAccount(
  entry: ControlledCutoffRelatedEntry,
  accounts: readonly string[],
): boolean {
  return Boolean(entry.lines?.some((line) => accounts.includes(line.account_number)))
}

function controlledYearEndKind(
  entry: ControlledCutoffRelatedEntry,
): 'cutoff' | 'scheduled_reversal' | null {
  if (entry.description === CUTOFF_PAYABLE_DESCRIPTION) return 'cutoff'
  if (entry.description === CUTOFF_PAYABLE_REVERSAL_DESCRIPTION) {
    return 'scheduled_reversal'
  }
  return null
}

function hasControlledYearEndShape(
  entry: ControlledCutoffRelatedEntry,
  companyId: string,
): boolean {
  return (
    entry.company_id === companyId
    && entry.source_type === 'year_end'
    && entry.source_id === null
    && entry.correction_of_id === null
    && entry.reverses_id === null
    && controlledYearEndKind(entry) !== null
    && hasAccount(entry, ['2648'])
    && !hasAccount(entry, VAT_SETTLEMENT_NET_ACCOUNTS)
  )
}

function hasWellFormedControlledLines(
  entry: ControlledCutoffRelatedEntry,
): boolean {
  return Boolean(
    entry.lines?.length
    && entry.lines.every((line) => lineEffectKey(line, false) !== null),
  )
}

function isExactControlledStorno(
  storno: ControlledCutoffRelatedEntry,
  original: ControlledCutoffRelatedEntry,
  companyId: string,
): boolean {
  return (
    original.company_id === companyId
    && original.status === 'reversed'
    && original.reversed_by_id === storno.id
    && storno.company_id === companyId
    && storno.status === 'posted'
    && storno.source_type === 'storno'
    && storno.source_id === null
    && storno.correction_of_id === null
    && storno.reverses_id === original.id
    && storno.reversed_by_id === null
    && storno.description === `Makulering: ${original.description}`
    && !hasAccount(storno, VAT_SETTLEMENT_NET_ACCOUNTS)
    && hasExactReversedEffect(original.lines, storno.lines)
  )
}

function isControlledCorrection(
  correction: ControlledCutoffRelatedEntry,
  parent: ControlledCutoffRelatedEntry,
  companyId: string,
): boolean {
  return (
    correction.company_id === companyId
    && (correction.status === 'posted' || correction.status === 'reversed')
    && correction.source_type === 'correction'
    && correction.source_id === null
    && correction.correction_of_id === parent.id
    && correction.reverses_id === null
    && !hasAccount(correction, VAT_SETTLEMENT_NET_ACCOUNTS)
    && hasWellFormedControlledLines(correction)
  )
}

function verifiedScheduledPairIds(
  entries: ControlledCutoffRelatedEntry[],
  companyId: string,
): Set<string> {
  const controlled = entries.filter((entry) =>
    entry.company_id === companyId
    && entry.source_type === 'year_end'
    && controlledYearEndKind(entry) !== null,
  )
  for (const entry of controlled) {
    if (
      !hasControlledYearEndShape(entry, companyId)
      || !hasWellFormedControlledLines(entry)
      || (entry.status !== 'posted' && entry.status !== 'reversed')
    ) {
      throw new Error(
        `malformed controlled cash-method cutoff entry ${entry.id}`,
      )
    }
  }
  const cutoffs = controlled.filter((entry) => controlledYearEndKind(entry) === 'cutoff')
  const reversals = controlled.filter(
    (entry) => controlledYearEndKind(entry) === 'scheduled_reversal',
  )
  const matchesByCutoff = new Map<string, ControlledCutoffRelatedEntry[]>()
  const matchesByReversal = new Map<string, ControlledCutoffRelatedEntry[]>()

  for (const cutoff of cutoffs) {
    for (const reversal of reversals) {
      if (
        reversal.entry_date === shiftedIsoDate(cutoff.entry_date, 1)
        && hasExactReversedEffect(cutoff.lines, reversal.lines)
      ) {
        const cutoffMatches = matchesByCutoff.get(cutoff.id) ?? []
        cutoffMatches.push(reversal)
        matchesByCutoff.set(cutoff.id, cutoffMatches)
        const reversalMatches = matchesByReversal.get(reversal.id) ?? []
        reversalMatches.push(cutoff)
        matchesByReversal.set(reversal.id, reversalMatches)
      }
    }
  }

  const verified = new Set<string>()
  for (const cutoff of cutoffs) {
    const matches = matchesByCutoff.get(cutoff.id) ?? []
    if (matches.length !== 1) {
      throw new Error(
        `ambiguous controlled cash-method cutoff reversal for ${cutoff.id}`,
      )
    }
    const reversal = matches[0]
    if ((matchesByReversal.get(reversal.id) ?? []).length !== 1) {
      throw new Error(
        `ambiguous controlled cash-method cutoff source for ${reversal.id}`,
      )
    }
    verified.add(cutoff.id)
    verified.add(reversal.id)
  }
  for (const reversal of reversals) {
    if (!verified.has(reversal.id)) {
      throw new Error(
        `orphan controlled cash-method cutoff reversal ${reversal.id}`,
      )
    }
  }
  return verified
}

function collectControlledLineageEntries(
  entryId: string,
  lineage: ControlledCutoffLineage,
  companyId: string,
  included: Set<string>,
  visiting: Set<string> = new Set(),
): void {
  const entry = lineage.entries.get(entryId)
  if (!entry) {
    throw new Error(`missing controlled cash-method cutoff lineage entry ${entryId}`)
  }
  if (visiting.has(entry.id)) {
    throw new Error(`cyclic controlled cash-method cutoff correction lineage at ${entry.id}`)
  }

  const corrections = lineage.correctionsByParent.get(entry.id) ?? []
  const reversals = lineage.reversalsByParent.get(entry.id) ?? []
  if (entry.status === 'posted') {
    if (entry.reversed_by_id !== null || corrections.length > 0 || reversals.length > 0) {
      throw new Error(
        `contradictory controlled cash-method cutoff lineage for ${entry.id}`,
      )
    }
    included.add(entry.id)
    return
  }
  if (entry.status !== 'reversed' || !entry.reversed_by_id) {
    throw new Error(`malformed controlled cash-method cutoff lineage for ${entry.id}`)
  }
  if (corrections.length > 1) {
    throw new Error(`ambiguous controlled cash-method cutoff correction for ${entry.id}`)
  }
  if (reversals.length !== 1) {
    throw new Error(`partial controlled cash-method cutoff storno lineage for ${entry.id}`)
  }

  const storno = reversals[0]
  if (!isExactControlledStorno(storno, entry, companyId)) {
    throw new Error(`malformed controlled cash-method cutoff storno ${storno.id}`)
  }
  included.add(entry.id)
  included.add(storno.id)

  const correction = corrections[0]
  if (!correction) return
  if (
    !isControlledCorrection(correction, entry, companyId)
    || storno.entry_date !== entry.entry_date
  ) {
    throw new Error(`malformed controlled cash-method cutoff correction ${correction.id}`)
  }

  const nextVisiting = new Set(visiting)
  nextVisiting.add(entry.id)
  collectControlledLineageEntries(
    correction.id,
    lineage,
    companyId,
    included,
    nextVisiting,
  )
}

function sumControlledCutoffInputVat(
  roots: ControlledCutoffRelatedEntry[],
  lineage: ControlledCutoffLineage,
  companyId: string,
  start: string,
  end: string,
): { debit: number; credit: number } {
  const verifiedPairs = verifiedScheduledPairIds(roots, companyId)
  const included = new Set<string>()
  for (const rootId of verifiedPairs) {
    collectControlledLineageEntries(rootId, lineage, companyId, included)
  }

  let debit = 0
  let credit = 0
  for (const entryId of included) {
    const entry = lineage.entries.get(entryId)
    if (!entry || entry.entry_date < start || entry.entry_date > end) continue
    for (const line of entry.lines ?? []) {
      if (line.account_number !== '2648') continue
      debit = round(debit + Number(line.debit_amount))
      credit = round(credit + Number(line.credit_amount))
    }
  }
  return { debit, credit }
}

function assertControlledEntryBound(
  count: number,
  context: string,
): void {
  if (count > CONTROLLED_CUTOFF_MAX_ENTRIES) {
    throw new Error(
      `${context} exceeds ${CONTROLLED_CUTOFF_MAX_ENTRIES} entries`,
    )
  }
}

async function fetchBoundedControlledRows<T>(
  query: (range: { from: number; to: number }) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
  context: string,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  while (rows.length <= CONTROLLED_CUTOFF_MAX_ENTRIES) {
    const remainingWithSentinel = CONTROLLED_CUTOFF_MAX_ENTRIES + 1 - rows.length
    const pageSize = Math.min(1000, remainingWithSentinel)
    const { data, error } = await query({ from, to: from + pageSize - 1 })
    if (error) throw new Error(error.message)
    if (!data?.length) break
    rows.push(...data)
    assertControlledEntryBound(rows.length, context)
    if (data.length < pageSize) break
    from += pageSize
  }
  return rows
}

function mergeControlledEntries(
  target: Map<string, ControlledCutoffRelatedEntry>,
  entries: ControlledCutoffRelatedEntry[],
): void {
  for (const entry of entries) {
    const existing = target.get(entry.id)
    if (
      existing
      && (
        existing.company_id !== entry.company_id
        || existing.status !== entry.status
        || existing.entry_date !== entry.entry_date
        || existing.description !== entry.description
        || existing.source_type !== entry.source_type
        || existing.source_id !== entry.source_id
        || existing.correction_of_id !== entry.correction_of_id
        || existing.reverses_id !== entry.reverses_id
        || existing.reversed_by_id !== entry.reversed_by_id
        || JSON.stringify(existing.lines) !== JSON.stringify(entry.lines)
      )
    ) {
      throw new Error(`conflicting controlled cash-method cutoff entry ${entry.id}`)
    }
    target.set(entry.id, entry)
  }
  assertControlledEntryBound(target.size, 'controlled cash-method cutoff lineage')
}

async function fetchControlledEntriesByIds(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<ControlledCutoffRelatedEntry[]> {
  const entries: ControlledCutoffRelatedEntry[] = []
  const uniqueIds = Array.from(new Set(entryIds)).sort()
  for (let offset = 0; offset < uniqueIds.length; offset += CONTROLLED_CUTOFF_ID_BATCH_SIZE) {
    const ids = uniqueIds.slice(offset, offset + CONTROLLED_CUTOFF_ID_BATCH_SIZE)
    const rows = await fetchAllRows<ControlledCutoffRelatedEntry>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select(`
          id, company_id, status, entry_date, description,
          source_type, source_id, correction_of_id, reverses_id, reversed_by_id,
          lines:journal_entry_lines(account_number, debit_amount, credit_amount)
        `)
        .eq('company_id', companyId)
        .in('status', ['posted', 'reversed'])
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    entries.push(...rows)
    assertControlledEntryBound(entries.length, 'controlled cash-method cutoff lookup')
  }
  return entries
}

function parseControlledLineageRow(value: unknown): ControlledCutoffLineageRow {
  if (!value || typeof value !== 'object') {
    throw new Error('malformed controlled cash-method cutoff lineage response')
  }
  const row = value as Record<string, unknown>
  if (
    typeof row.root_id !== 'string'
    || typeof row.id !== 'string'
    || typeof row.entry_date !== 'string'
    || typeof row.status !== 'string'
    || (row.source_type !== null && typeof row.source_type !== 'string')
    || (row.correction_of_id !== null && typeof row.correction_of_id !== 'string')
    || (row.reverses_id !== null && typeof row.reverses_id !== 'string')
    || (row.parent_id !== null && typeof row.parent_id !== 'string')
    || (row.edge_kind !== 'root'
      && row.edge_kind !== 'correction'
      && row.edge_kind !== 'storno')
    || !Number.isInteger(row.depth)
    || !Array.isArray(row.path)
    || !row.path.every((id) => typeof id === 'string')
    || typeof row.cycle !== 'boolean'
  ) {
    throw new Error('malformed controlled cash-method cutoff lineage response')
  }
  return row as unknown as ControlledCutoffLineageRow
}

async function fetchControlledCutoffLineage(
  supabase: SupabaseClient,
  companyId: string,
  roots: ControlledCutoffRelatedEntry[],
  knownEntries: Map<string, ControlledCutoffRelatedEntry>,
): Promise<ControlledCutoffLineage> {
  const rootIds = Array.from(new Set(roots.map((entry) => entry.id))).sort()
  const rows: ControlledCutoffLineageRow[] = []

  for (let offset = 0; offset < rootIds.length; offset += CONTROLLED_CUTOFF_ROOT_BATCH_SIZE) {
    const batchRootIds = rootIds.slice(
      offset,
      offset + CONTROLLED_CUTOFF_ROOT_BATCH_SIZE,
    )
    const { data, error } = await supabase.rpc('get_supplier_payment_lineage', {
      p_company_id: companyId,
      p_root_ids: batchRootIds,
    })
    if (error) {
      throw new Error(`controlled cash-method cutoff lineage RPC failed: ${error.message}`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('malformed controlled cash-method cutoff lineage response')
    }
    const payload = data as Record<string, unknown>
    if (
      payload.requested_root_count !== batchRootIds.length
      || !Array.isArray(payload.rows)
    ) {
      throw new Error('malformed controlled cash-method cutoff lineage response')
    }
    const batchRoots = new Set(batchRootIds)
    for (const value of payload.rows) {
      const row = parseControlledLineageRow(value)
      if (!batchRoots.has(row.root_id)) {
        throw new Error(`unexpected controlled cash-method cutoff root ${row.root_id}`)
      }
      rows.push(row)
      assertControlledEntryBound(rows.length, 'controlled cash-method cutoff lineage')
    }
  }

  const lineageEntryIds = Array.from(new Set(rows.map((row) => row.id)))
  const missingEntryIds = lineageEntryIds.filter((id) => !knownEntries.has(id))
  mergeControlledEntries(
    knownEntries,
    await fetchControlledEntriesByIds(supabase, companyId, missingEntryIds),
  )
  const unresolvedEntries = lineageEntryIds.filter((id) => !knownEntries.has(id))
  if (unresolvedEntries.length > 0) {
    throw new Error(
      `missing ${unresolvedEntries.length} controlled cash-method cutoff lineage entries`,
    )
  }

  const requested = new Set(rootIds)
  const resolvedRoots = new Set<string>()
  const rpcEntries = new Map<string, ControlledCutoffLineageRow>()
  const corrections = new Map<string, Map<string, ControlledCutoffRelatedEntry>>()
  const reversals = new Map<string, Map<string, ControlledCutoffRelatedEntry>>()
  for (const row of rows) {
    const entry = knownEntries.get(row.id)!
    if (
      !requested.has(row.root_id)
      || row.path[0] !== row.root_id
      || row.path.at(-1) !== row.id
      || row.path.length !== row.depth + 1
      || (
        row.depth > CONTROLLED_CUTOFF_MAX_DEPTH
        && !(
          row.edge_kind === 'storno'
          && row.depth === CONTROLLED_CUTOFF_MAX_DEPTH + 1
        )
      )
      || row.cycle
      || entry.entry_date !== row.entry_date
      || entry.status !== row.status
      || entry.source_type !== row.source_type
      || entry.correction_of_id !== row.correction_of_id
      || entry.reverses_id !== row.reverses_id
    ) {
      throw new Error(`malformed controlled cash-method cutoff lineage at ${row.id}`)
    }
    const existing = rpcEntries.get(row.id)
    if (
      existing
      && (
        existing.entry_date !== row.entry_date
        || existing.status !== row.status
        || existing.source_type !== row.source_type
        || existing.correction_of_id !== row.correction_of_id
        || existing.reverses_id !== row.reverses_id
      )
    ) {
      throw new Error(`conflicting controlled cash-method cutoff lineage at ${row.id}`)
    }
    rpcEntries.set(row.id, row)

    if (row.edge_kind === 'root') {
      if (
        row.parent_id !== null
        || row.depth !== 0
        || row.id !== row.root_id
        || resolvedRoots.has(row.root_id)
      ) {
        throw new Error(`malformed controlled cash-method cutoff root ${row.root_id}`)
      }
      resolvedRoots.add(row.root_id)
      continue
    }
    if (!row.parent_id) {
      throw new Error(`orphan controlled cash-method cutoff lineage at ${row.id}`)
    }
    const target = row.edge_kind === 'correction' ? corrections : reversals
    const children = target.get(row.parent_id)
      ?? new Map<string, ControlledCutoffRelatedEntry>()
    children.set(row.id, entry)
    target.set(row.parent_id, children)
  }

  for (const row of rows) {
    if (
      row.edge_kind !== 'root'
      && (!row.parent_id || !rpcEntries.has(row.parent_id))
    ) {
      throw new Error(`orphan controlled cash-method cutoff lineage at ${row.id}`)
    }
  }
  const unresolvedRoots = rootIds.filter((id) => !resolvedRoots.has(id))
  if (unresolvedRoots.length > 0) {
    throw new Error(
      `missing ${unresolvedRoots.length} controlled cash-method cutoff roots`,
    )
  }
  for (const [parentId, children] of corrections) {
    if (children.size > 1) {
      throw new Error(`ambiguous controlled cash-method cutoff correction for ${parentId}`)
    }
  }
  for (const [parentId, children] of reversals) {
    if (children.size > 1) {
      throw new Error(`ambiguous controlled cash-method cutoff storno for ${parentId}`)
    }
  }

  return {
    entries: knownEntries,
    correctionsByParent: new Map(
      Array.from(corrections, ([parentId, children]) => [parentId, [...children.values()]]),
    ),
    reversalsByParent: new Map(
      Array.from(reversals, ([parentId, children]) => [parentId, [...children.values()]]),
    ),
  }
}

/**
 * Find 2648-bearing candidates in the requested period, walk at most 32
 * ancestor edges in 100-id batches, then resolve each controlled year-end
 * root's complete descendants through bounded lineage RPC batches. This
 * admits correction rows only when they descend from an exact app-created
 * cutoff pair.
 */
async function fetchControlledCutoffInputVat(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<{ debit: number; credit: number }> {
  try {
    const anchors = await fetchBoundedControlledRows<ControlledCutoffRelatedEntry>(
      ({ from, to }) =>
        supabase
          .from('journal_entries')
          .select(`
            id, company_id, status, entry_date, description,
            source_type, source_id, correction_of_id, reverses_id, reversed_by_id,
            lines:journal_entry_lines(account_number, debit_amount, credit_amount),
            vat_lines:journal_entry_lines!inner(id)
          `)
          .eq('company_id', companyId)
          .in('status', ['posted', 'reversed'])
          .in('source_type', ['year_end', 'storno', 'correction'])
          .gte('entry_date', shiftedIsoDate(start, -1))
          .lte('entry_date', shiftedIsoDate(end, 1))
          .eq('vat_lines.account_number', '2648')
          .order('id', { ascending: true })
          .range(from, to),
      'controlled cash-method cutoff lookup',
    )
    assertControlledEntryBound(anchors.length, 'controlled cash-method cutoff lookup')
    if (anchors.length === 0) return { debit: 0, credit: 0 }

    const knownEntries = new Map<string, ControlledCutoffRelatedEntry>()
    mergeControlledEntries(knownEntries, anchors)
    let parentIds = Array.from(new Set(
      anchors.flatMap((entry) =>
        [entry.correction_of_id, entry.reverses_id].filter(
          (id): id is string => id !== null,
        ),
      ),
    ))
    const expandedAncestors = new Set<string>()
    let depth = 0
    while (parentIds.length > 0 && depth < CONTROLLED_CUTOFF_MAX_DEPTH) {
      const currentParentIds = parentIds.filter((id) => !expandedAncestors.has(id))
      if (currentParentIds.length === 0) break
      currentParentIds.forEach((id) => expandedAncestors.add(id))
      const unresolved = currentParentIds.filter((id) => !knownEntries.has(id))
      const fetchedParents = await fetchControlledEntriesByIds(
        supabase,
        companyId,
        unresolved,
      )
      mergeControlledEntries(knownEntries, fetchedParents)
      const missing = unresolved.filter((id) => !knownEntries.has(id))
      if (missing.length > 0) {
        const malformedStorno = [...knownEntries.values()].find((entry) =>
          entry.source_type === 'storno'
          && entry.reverses_id !== null
          && missing.includes(entry.reverses_id)
          && (
            entry.description === `Makulering: ${CUTOFF_PAYABLE_DESCRIPTION}`
            || entry.description === `Makulering: ${CUTOFF_PAYABLE_REVERSAL_DESCRIPTION}`
          ),
        )
        if (malformedStorno) {
          throw new Error(
            `malformed controlled cash-method cutoff storno ${malformedStorno.id}`,
          )
        }
        throw new Error(
          `missing ${missing.length} controlled cash-method cutoff ancestors`,
        )
      }
      const parents = currentParentIds.map((id) => knownEntries.get(id)!)
      parentIds = Array.from(new Set(
        parents.flatMap((entry) =>
          [entry.correction_of_id, entry.reverses_id].filter(
            (id): id is string => id !== null,
          ),
        ),
      ))
      depth += 1
    }
    if (parentIds.some((id) => !expandedAncestors.has(id))) {
      throw new Error(
        `controlled cash-method cutoff ancestry exceeds ${CONTROLLED_CUTOFF_MAX_DEPTH} edges`,
      )
    }

    const discoveredRoots = [...knownEntries.values()].filter((entry) =>
      entry.source_type === 'year_end'
      && controlledYearEndKind(entry) !== null,
    )
    if (discoveredRoots.length === 0) return { debit: 0, credit: 0 }

    const companionDates = Array.from(new Set(
      discoveredRoots.flatMap((entry) => [
        shiftedIsoDate(entry.entry_date, -1),
        entry.entry_date,
        shiftedIsoDate(entry.entry_date, 1),
      ]),
    )).sort()
    for (
      let offset = 0;
      offset < companionDates.length;
      offset += CONTROLLED_CUTOFF_ID_BATCH_SIZE
    ) {
      const dates = companionDates.slice(offset, offset + CONTROLLED_CUTOFF_ID_BATCH_SIZE)
      const companions = await fetchBoundedControlledRows<ControlledCutoffRelatedEntry>(({ from, to }) =>
        supabase
          .from('journal_entries')
          .select(`
            id, company_id, status, entry_date, description,
            source_type, source_id, correction_of_id, reverses_id, reversed_by_id,
            lines:journal_entry_lines(account_number, debit_amount, credit_amount),
            vat_lines:journal_entry_lines!inner(id)
          `)
          .eq('company_id', companyId)
          .in('status', ['posted', 'reversed'])
          .eq('source_type', 'year_end')
          .in('description', [
            CUTOFF_PAYABLE_DESCRIPTION,
            CUTOFF_PAYABLE_REVERSAL_DESCRIPTION,
          ])
          .in('entry_date', dates)
          .eq('vat_lines.account_number', '2648')
          .order('id', { ascending: true })
          .range(from, to),
        'controlled cash-method cutoff companion lookup',
      )
      mergeControlledEntries(knownEntries, companions)
    }

    const roots = [...knownEntries.values()].filter((entry) =>
      entry.source_type === 'year_end'
      && controlledYearEndKind(entry) !== null,
    )
    const lineage = await fetchControlledCutoffLineage(
      supabase,
      companyId,
      roots,
      knownEntries,
    )
    return sumControlledCutoffInputVat(roots, lineage, companyId, start, end)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`controlled cutoff 2648 lookup failed: ${message}`)
  }
}

/**
 * Fetch and aggregate debit/credit totals per VAT-relevant account
 * (ACCOUNT_RUTA) for a period. Shared by the declaration calculation and the
 * settlement proposal (lib/reports/vat-settlement.ts) so the two can never
 * disagree on which ledger lines count.
 *
 * Momsredovisning entries are excluded. They are bookkeeping about the
 * declaration, not VAT-bearing business activity; including them would zero
 * out the rutor the moment the settlement is booked, turning the report, its
 * exports, and a later Skatteverket submission into an empty declaration
 * (#984). Two detection paths:
 *
 *   - tagged: source_type 'vat_settlement' (the app's own settlement flow),
 *     filtered in the query;
 *   - shaped: an entry with at least one line on a declaration account
 *     (ACCOUNT_RUTA) and at least one on 2650/1650. This catches settlements
 *     booked before the tagged flow existed, manual vouchers, SIE-imported
 *     settlements, and storno reversals of a settlement (source_type
 *     'storno', which would otherwise re-inflate the rutor after annullera).
 *
 * Opening-balance entries are exempt from the shape rule: 26xx balances
 * carried in by a migrating company are unsettled VAT that belongs in the
 * next declaration, even when the same entry carries a 2650/1650 balance.
 */
export async function fetchVatAccountTotals(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  dynamicRuta05Accounts: string[] = []
): Promise<VatAccountTotals> {
  // Aggregation, settlement-shape detection, and source_type counts all
  // happen in one SQL pass (get_vat_declaration_totals). The previous
  // implementation paged every entry + line for the period through PostgREST
  // and reduced in JS: dozens of round trips for a busy quarter. The account
  // lists are parameters so ACCOUNT_RUTA stays the single source of truth.
  //
  // The company's own ruta 05 accounts join p_accounts (they must be summed)
  // but deliberately NOT p_ruta_accounts. That second list is the settlement
  // SHAPE detector: an entry with a line on it plus a line on 2650/1650 is
  // classified a momsredovisning and dropped from the totals entirely. A plain
  // sale booked 1930 / 3013 / 2650 (a company clearing moms straight off the
  // revenue voucher) would then vanish from its own declaration. The fixed
  // ACCOUNT_RUTA list is what defines settlement shape; user accounts widen
  // what is measured, never what counts as a momsredovisning.
  const { data, error } = await supabase.rpc('get_vat_declaration_totals', {
    p_company_id: companyId,
    p_start: start,
    p_end: end,
    p_accounts: [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS, ...dynamicRuta05Accounts],
    p_ruta_accounts: VAT_ACCOUNTS,
    p_net_accounts: VAT_SETTLEMENT_NET_ACCOUNTS,
  })
  if (error) {
    throw new Error(`get_vat_declaration_totals failed: ${error.message}`)
  }

  const payload = (data ?? {}) as Partial<VatTotalsRpcPayload>
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const row of payload.totals ?? []) {
    totals.set(row.account_number, {
      debit: Number(row.debit) || 0,
      credit: Number(row.credit) || 0,
    })
  }

  return {
    totals,
    settlementShapedEntries: payload.settlement_shaped_entries ?? [],
    sourceTypeCounts: payload.source_type_counts ?? {},
  }
}

/**
 * Map aggregated per-account totals to the momsdeklaration boxes, including
 * the recomputed ruta 49 net (FK009). Pure projection over the private
 * RUTA_PROJECTION plus the company's own ruta 05 accounts.
 *
 * `dynamicRuta05Accounts` is optional so callers that only need the 26xx boxes
 * keep working untouched: ruta 05 is a beskattningsunderlag, not moms, so it
 * never reaches ruta 49 and the settlement proposal nets the same either way.
 */
export function rutorFromTotals(
  totals: Map<string, { debit: number; credit: number }>,
  dynamicRuta05Accounts: string[] = []
): VatDeclarationRutor {
  const rutor: VatDeclarationRutor = {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
  }

  for (const [account, mapping] of Object.entries(RUTA_PROJECTION)) {
    const t = totals.get(account)
    if (!t) continue
    const balance = mapping.side === 'credit'
      ? t.credit - t.debit
      : t.debit - t.credit
    rutor[mapping.box] = round(rutor[mapping.box] + balance)
  }

  // The company's own momspliktiga intäktskonton. Always credit-side: these are
  // revenue accounts by construction (account_class 3).
  for (const account of dynamicRuta05Accounts) {
    const t = totals.get(account)
    if (!t) continue
    rutor.ruta05 = round(rutor.ruta05 + (t.credit - t.debit))
  }

  // FK009: summaMoms = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
  rutor.ruta49 = round(
    rutor.ruta10 + rutor.ruta11 + rutor.ruta12 +
    rutor.ruta30 + rutor.ruta31 + rutor.ruta32 +
    rutor.ruta60 + rutor.ruta61 + rutor.ruta62 -
    rutor.ruta48
  )

  return rutor
}

/**
 * Project the reverse-charge input pair (2645/2647) out of a full totals map,
 * for `VatDeclaration.rcInputAccountTotals`.
 *
 * Both keys are always present, zeros included, so the wire shape is stable and
 * an absent field keeps meaning "this producer does not carry the pair" rather
 * than "no reverse charge in the period".
 */
function rcInputTotals(
  totals: Map<string, { debit: number; credit: number }>
): Record<string, { debit: number; credit: number }> {
  const pair: Record<string, { debit: number; credit: number }> = {}
  for (const account of RC_INPUT_VAT_ACCOUNTS) {
    const t = totals.get(account)
    pair[account] = { debit: round(t?.debit ?? 0), credit: round(t?.credit ?? 0) }
  }
  return pair
}

/**
 * Rebuild the per-account totals map `runVatDeclarationChecks` takes as its
 * optional second argument, from a declaration that may have arrived as JSON
 * over HTTP.
 *
 * Returns undefined when the pair is absent, which makes the check fall back to
 * its weaker ruta 48 comparison. That is deliberate: an empty map would read as
 * "0 kr beräknad ingående moms" and turn a correct declaration into a warning.
 */
export function rcInputTotalsFromDeclaration(
  declaration: Pick<VatDeclaration, 'rcInputAccountTotals'>
): VatCheckAccountTotals | undefined {
  const pair = declaration.rcInputAccountTotals
  return pair ? new Map(Object.entries(pair)) : undefined
}

/**
 * Calculate VAT declaration from the general ledger.
 *
 * Sums posted journal entry lines on the statically mapped BAS accounts.
 * Account 2648 is admitted only through verified journal metadata and exact
 * reversal lineage; supplier classification and accounting-method settings
 * remain irrelevant.
 *
 *   - ruta 49 = (10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48
 *
 * INVARIANT: the company's accounting method (faktureringsmetoden vs
 * kontantmetoden) needs no parameter here and must not become one. The method
 * is already baked into journal entry TIMING: kontantmetod companies post
 * VAT-bearing entries at payment date, faktureringsmetod companies at invoice
 * date, so summing posted lines per period is correct for both. A method
 * parameter existed until 2026-07-23 and was silently ignored; it was removed
 * so no future code path can branch on a value that callers hard-code.
 */
export async function calculateVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  options: { fiscalPeriodId?: string } = {}
): Promise<VatDeclaration> {
  const validated = parseVatPeriodInput({ periodType, year, period })
  // For yearly VAT this resolves to the räkenskapsår bounds (when a fiscal
  // period is supplied), not the calendar year: see resolvePeriodDates.
  const { start, end, fiscalPeriodId, fiscalPeriodStart, fiscalPeriodEnd } = await resolvePeriodDates(
    supabase,
    companyId,
    validated.periodType,
    validated.year,
    validated.period,
    options.fiscalPeriodId,
  )

  // Which of the company's OWN class 3 accounts count as momspliktig
  // försäljning. Resolved from their "Standard moms" rather than a fixed BAS
  // list, because Accounted seeds no varugrupp accounts: every 3011/3013-style
  // konto is user-added and would otherwise never be fetched at all (#1261).
  const dynamicRuta05 = await fetchDynamicRuta05Accounts(supabase, companyId)

  // Aggregate statically mapped accounts and resolve the controlled 2648
  // exception independently. The second path is company-scoped and bounded;
  // it pages candidate entries, then resolves ancestry and descendants in
  // batches rather than issuing one query per correction edge.
  const [
    { totals, sourceTypeCounts },
    controlledCutoffInputVat,
  ] = await Promise.all([
    fetchVatAccountTotals(
      supabase, companyId, start, end, dynamicRuta05.accounts,
    ),
    fetchControlledCutoffInputVat(supabase, companyId, start, end),
  ])
  totals.set(CONTROLLED_CUTOFF_INPUT_VAT_KEY, controlledCutoffInputVat)

  // Map account balances to momsdeklaration boxes.
  const rutor = rutorFromTotals(totals, dynamicRuta05.accounts)

  // Compute per-rate base amounts from individual revenue accounts. The
  // company's own accounts carry their rate on the konto itself, so they land
  // in the same three buckets: without that, a 3013 company would show a
  // ruta 05 base that none of base25/12/6 accounts for.
  //
  // These three are REPORTING metadata (breakdown.invoices), not check inputs:
  // vat-declaration-checks.ts derives its expected base from the output-VAT
  // rutor (ruta10/0.25 + ruta11/0.12 + ruta12/0.06) and never reads base25/12/6.
  // So an incomplete split understates nothing that gets filed; it only makes
  // the breakdown fail to add up to ruta 05.
  const revenueByRate = {
    base25: 0,  // 3001
    base12: 0,  // 3002
    base6: 0,   // 3003
  }
  const RATE_BUCKET = { 0.25: 'base25', 0.12: 'base12', 0.06: 'base6' } as const
  for (const [account, rate] of [['3001', 'base25'], ['3002', 'base12'], ['3003', 'base6']] as const) {
    const t = totals.get(account)
    if (t) revenueByRate[rate] = round(t.credit - t.debit)
  }
  for (const [account, rate] of dynamicRuta05.rateByAccount) {
    const t = totals.get(account)
    if (!t) continue
    const bucket = RATE_BUCKET[rate as keyof typeof RATE_BUCKET]
    if (!bucket) continue
    revenueByRate[bucket] = round(revenueByRate[bucket] + (t.credit - t.debit))
  }
  // Accounts the static map ALREADY sums into ruta 05 (3000, the 30xx
  // gruppkonto) but whose rate only exists as the konto's "Standard moms".
  // Rate-only on purpose: their balance is in ruta 05 either way, so adding
  // them to dynamicRuta05.accounts would double the filed figure.
  for (const [account, rate] of dynamicRuta05.staticRateByAccount) {
    const t = totals.get(account)
    if (!t) continue
    const bucket = RATE_BUCKET[rate as keyof typeof RATE_BUCKET]
    if (!bucket) continue
    revenueByRate[bucket] = round(revenueByRate[bucket] + (t.credit - t.debit))
  }

  // Entry counts by source type for metadata: aggregated by the RPC in the
  // same round trip as the totals (SQL GROUP BY, so a busy VAT period can
  // never truncate the counts).
  const invoiceSources = new Set([
    'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note',
  ])
  let invoiceCount = 0
  let transactionCount = 0
  for (const [sourceType, n] of Object.entries(sourceTypeCounts)) {
    if (invoiceSources.has(sourceType)) invoiceCount += n
    else if (sourceType === 'bank_transaction') transactionCount += n
  }

  return {
    period: {
      type: validated.periodType,
      year: validated.year,
      period: validated.period,
      start,
      end,
      ...(fiscalPeriodId ? { fiscalPeriodId } : {}),
      ...(fiscalPeriodStart ? { fiscalPeriodStart } : {}),
      ...(fiscalPeriodEnd ? { fiscalPeriodEnd } : {}),
    },
    rutor,
    // The 2645/2647 pair travels with the declaration so an HTTP caller can run
    // the sharp RC_INPUT_VAT_MISMATCH comparison instead of the ruta 48
    // fallback: see VatDeclaration.rcInputAccountTotals.
    rcInputAccountTotals: rcInputTotals(totals),
    // Per-momssats RC basis balances (44xx/45xx), the downgrade evidence for
    // the per-voucher gap tiering: see VatDeclaration.rcBasisByRate.
    rcBasisByRate: rcBasisTotalsByRate(totals),
    invoiceCount,
    transactionCount,
    breakdown: {
      invoices: {
        ruta05: rutor.ruta05,
        ruta06: rutor.ruta06,
        ruta07: rutor.ruta07,
        ruta10: rutor.ruta10,
        ruta11: rutor.ruta11,
        ruta12: rutor.ruta12,
        ruta39: rutor.ruta39,
        ruta40: rutor.ruta40,
        base25: revenueByRate.base25,
        base12: revenueByRate.base12,
        base6: revenueByRate.base6,
      },
      transactions: { ruta48: rutor.ruta48 },
      receipts: { ruta48: 0 },
      reverseCharge: {
        ruta20: rutor.ruta20,
        ruta21: rutor.ruta21,
        ruta22: rutor.ruta22,
        ruta23: rutor.ruta23,
        ruta24: rutor.ruta24,
        ruta30: rutor.ruta30,
        ruta31: rutor.ruta31,
        ruta32: rutor.ruta32,
      },
    },
  }
}

/**
 * Get a summary of the VAT declaration for display
 */
export function getVatDeclarationSummary(declaration: VatDeclaration): {
  totalOutputVat: number
  totalInputVat: number
  vatToPay: number
  isRefund: boolean
} {
  const totalOutputVat = round(
    declaration.rutor.ruta10 +
    declaration.rutor.ruta11 +
    declaration.rutor.ruta12 +
    declaration.rutor.ruta30 +
    declaration.rutor.ruta31 +
    declaration.rutor.ruta32 +
    declaration.rutor.ruta60 +
    declaration.rutor.ruta61 +
    declaration.rutor.ruta62
  )

  const totalInputVat = declaration.rutor.ruta48
  const vatToPay = declaration.rutor.ruta49

  return {
    totalOutputVat,
    totalInputVat,
    vatToPay,
    isRefund: vatToPay < 0,
  }
}

/**
 * Format period label for display
 */
export function formatPeriodLabel(
  periodType: VatPeriodType,
  year: number,
  period: number
): string {
  switch (periodType) {
    case 'monthly':
      const monthNames = [
        'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
        'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December'
      ]
      return `${monthNames[period - 1]} ${year}`
    case 'quarterly':
      return `Kvartal ${period} ${year}`
    case 'yearly':
      return `Helår ${year}`
    default:
      return `${year}`
  }
}
