import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclarationRutor, VatPeriodType } from '@/types'
import {
  runVatDeclarationChecks,
  type VatCheckAccountTotals,
  type VatDeclarationCheck,
} from './vat-declaration-checks'
import { findRcBasisGaps } from './rc-basis-gaps'

/**
 * The filing gate for the momsdeklaration: ONE derived value that the
 * "Kontroll av underlaget" banner, the stegen counters and the "Skicka till
 * Skatteverket" button all read.
 *
 * Why this exists: `runVatDeclarationChecks` compares PERIOD TOTALS with a
 * tolerance, while `/api/reports/vat-declaration/rc-basis-gaps` scans PER
 * VERIFIKAT with no tolerance. The two disagree by design:
 *
 * - the RC tolerance scales with period size (0.5% of the implied basis), so
 *   a handful of vouchers can each miss their basbelopp while the period
 *   shortfall still lands inside it. At a 400 000 kr basis that hides up to
 *   2 000 kr of missing underlag.
 * - a partly finished korrigering clears the aggregate long before the last
 *   broken voucher is fixed (the worklist itself documents this).
 *
 * Before this helper the banner and the send gate read the aggregate only, so
 * the UI could render "Inga fel hittades i underlaget för perioden" directly
 * above a worklist of the very verifikationer that make the declaration
 * wrong, with Skicka enabled.
 *
 * The per-voucher scan is authoritative here: every gap it returns is a
 * verifikat with fiktiv moms on 2614/2624/2634 and no matching basbelopp on
 * 44xx/45xx, which understates rutorna 20-24. Vid omvänd skattskyldighet ska
 * köparen redovisa BÅDE beskattningsunderlaget (ruta 20-24) och den fiktiva
 * momsen (ruta 30-32); tyst kvittning är inte tillåten, och Skatteverkets
 * gateway avvisar den obalansen med felkod FK004. En sådan deklaration är
 * alltså ofullständig, inte bara misstänkt, so it blocks filing exactly like
 * the aggregate ERROR it stands in for.
 *
 * Blocking, not advisory, is safe here because the block is not a dead end:
 * the one-click Korrigera worklist sits on the same page directly under the
 * finding, and the manual filing route (eSKD-XML and PDF in
 * VatManualFilingCard) is deliberately left ungated, so a user who disagrees
 * with the finding can still file. Only the direct SKV submission is gated.
 *
 * This module owns only the gate. The 0.5% tolerance itself belongs to
 * vat-declaration-checks.ts and is deliberately untouched here.
 */

/**
 * What the per-verifikat scan currently knows.
 *
 * `pending` and `unavailable` are kept apart on purpose: neither is "inga
 * brister", but only a settled failure is worth telling the user about. An
 * in-flight scan says nothing; a failed one must not be allowed to pass as an
 * all-clear.
 */
export type RcBasisGapScan =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'scanned'; gapCount: number }

/**
 * The synthetic finding that makes per-voucher gaps visible to the gate.
 *
 * It reuses the `RC_BASIS_MISSING` code on purpose: it is the same defect the
 * aggregate check describes, only detected per verifikat, and the worklist in
 * VatChecksCard keys its own visibility off that code.
 */
export function rcBasisGapFinding(gapCount: number): VatDeclarationCheck {
  const subject = gapCount === 1 ? '1 verifikation' : `${gapCount} verifikationer`
  const remedy =
    gapCount === 1
      ? 'Korrigera verifikationen i listan nedan innan du lämnar in.'
      : 'Korrigera verifikationerna i listan nedan innan du lämnar in.'
  return {
    code: 'RC_BASIS_MISSING',
    status: 'ERROR',
    message:
      `${subject} i perioden har fiktiv moms (2614/2624/2634) utan basbelopp ` +
      'på 44xx/45xx, så ruta 20-24 är för låga. Vid omvänd skattskyldighet ska ' +
      'både beskattningsunderlaget (ruta 20-24) och den fiktiva momsen ' +
      `(ruta 30-32) redovisas; Skatteverket avvisar annars med felkod FK004. ${remedy}`,
    rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
  }
}

/**
 * Shown when the required per-verifikat scan could not run. Filing and close
 * checks fail closed because an unavailable scan cannot establish that the
 * declaration is complete. The stable code distinguishes unavailable evidence
 * from an observed missing basis amount.
 */
export function rcBasisScanUnavailableFinding(): VatDeclarationCheck {
  return {
    code: 'RC_BASIS_SCAN_UNAVAILABLE',
    status: 'ERROR',
    message:
      'Kontrollen av enskilda verifikationer kunde inte köras, så vi vet inte ' +
      'om någon verifikation har fiktiv moms (2614/2624/2634) utan basbelopp ' +
      'på 44xx/45xx. Ladda om sidan för att försöka igen. Om listan nedan ' +
      'innehåller verifikationer ska de korrigeras innan du lämnar in.',
    rutor: ['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32'],
  }
}

/**
 * Fold the per-verifikat scan into the check list the UI renders and gates on.
 * Everything downstream (banner, stegen counters, Skicka) reads the returned
 * array, so there is one list and no second opinion.
 */
export function withRcBasisGapFindings(
  checks: VatDeclarationCheck[],
  scan: RcBasisGapScan,
): VatDeclarationCheck[] {
  // The aggregate check already says this, and already blocks; don't say it
  // twice, and don't stack a "could not check" note on top of a live finding.
  if (checks.some((c) => c.code === 'RC_BASIS_MISSING')) return checks
  if (scan.status === 'pending') return checks
  if (scan.status === 'unavailable') return [...checks, rcBasisScanUnavailableFinding()]
  if (scan.gapCount <= 0) return checks
  return [...checks, rcBasisGapFinding(scan.gapCount)]
}

/**
 * The single send gate. Everything that claims "all clear" or enables filing
 * must read this over the SAME array, or the two will drift apart again.
 */
export function isFilingBlocked(checks: VatDeclarationCheck[]): boolean {
  return checks.some((c) => c.status === 'ERROR')
}

/**
 * Run the complete local filing gate for one exact company and legal period.
 * Required per-voucher evidence fails closed; advisory findings remain
 * warnings and therefore do not block filing.
 */
export async function evaluateVatFilingGate(
  supabase: SupabaseClient,
  companyId: string,
  rutor: VatDeclarationRutor,
  periodType: VatPeriodType,
  year: number,
  period: number,
  accountTotals?: VatCheckAccountTotals,
  options: { fiscalPeriodId?: string } = {},
): Promise<{ checks: VatDeclarationCheck[]; blocked: boolean }> {
  let scan: RcBasisGapScan
  try {
    const gaps = await findRcBasisGaps(
      supabase,
      companyId,
      periodType,
      year,
      period,
      options,
    )
    scan = { status: 'scanned', gapCount: gaps.length }
  } catch {
    scan = { status: 'unavailable' }
  }

  const checks = withRcBasisGapFindings(
    runVatDeclarationChecks(rutor, accountTotals),
    scan,
  )
  return { checks, blocked: isFilingBlocked(checks) }
}
