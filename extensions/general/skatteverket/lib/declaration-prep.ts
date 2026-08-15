import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclarationRutor, VatPeriodType } from '@/types'
import {
  calculateVatDeclaration,
  type VatResolvedPeriod,
} from '@/lib/reports/vat-declaration'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { findRcBasisGaps } from '@/lib/reports/rc-basis-gaps'
import {
  isFilingBlocked,
  withRcBasisGapFindings,
  type RcBasisGapScan,
} from '@/lib/reports/vat-filing-gate'
import {
  rutorToMomsuppgift,
  formatRedovisare,
  formatRedovisningsperiod,
} from './mappers'
import type { SkatteverketMomsuppgift } from '../types'
import {
  VatSubmissionConflictError,
  assertSameVatSubmissionIdentity,
  canonicalVatRutor,
  vatSubmissionIdentity,
  type VatSubmissionIdentity,
} from './vat-submission-state'

/**
 * Request-free Skatteverket declaration prep.
 *
 * These functions are the single source of truth for what gets filed to
 * Skatteverket. They are shared by the HTTP route handlers
 * (parseDeclarationRequest / loadAGIXml) and the commit-side services
 * (commitSubmitVatDeclaration / commitSubmitAgi) so the numbers and XML
 * computed at preview time match exactly what is filed at commit time.
 *
 * Compliance-critical: drift between the two paths would mean different
 * figures filed to SKV than the user reviewed. Keep these the only place that
 * computes momsuppgift / loads AGI XML.
 */

export interface VatDeclarationPrep {
  redovisare: string
  redovisningsperiod: string
  momsuppgift: SkatteverketMomsuppgift
  rutor: VatDeclarationRutor
  period: VatResolvedPeriod
  identity: VatSubmissionIdentity
}

export interface AgiUnderlagPrep {
  arbetsgivare: string
  period: string // YYYYMM
  salaryRunId: string
  xml: string
  periodYear: number
  periodMonth: number
}

/**
 * Resolve a company's 12-digit "redovisare" string from company_settings.
 * Shared by the VAT and AGI paths and by the status tools that only need the
 * identifier (no momsuppgift / XML compute).
 */
export async function resolveRedovisare(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .single()

  if (!settings?.org_number) {
    throw new Error('Organisationsnummer saknas i företagsinställningar')
  }

  return formatRedovisare(settings.org_number, settings.entity_type)
}

/**
 * Compute and verify the exact VAT declaration that may be filed. The approved
 * rutor come from the rendered declaration. A fresh ledger projection must
 * still match them before the first Skatteverket write is permitted.
 */
export async function buildMomsuppgift(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    periodType: VatPeriodType
    year: number
    period: number
    fiscalPeriodId?: string
    approvedRutor?: VatDeclarationRutor
  },
): Promise<VatDeclarationPrep> {
  const [redovisare, declaration] = await Promise.all([
    resolveRedovisare(supabase, companyId),
    calculateVatDeclaration(
      supabase,
      companyId,
      input.periodType,
      input.year,
      input.period,
      { fiscalPeriodId: input.fiscalPeriodId },
    ),
  ])
  const approvedRutor = input.approvedRutor
    ? canonicalVatRutor(input.approvedRutor)
    : declaration.rutor
  const momsuppgift = rutorToMomsuppgift(declaration.rutor)
  const redovisningsperiod =
    `${declaration.period.originalEnd.slice(0, 4)}${declaration.period.originalEnd.slice(5, 7)}`
  const identity = vatSubmissionIdentity({
    redovisare,
    redovisningsperiod,
    period: declaration.period,
    approvedRutor: declaration.rutor,
    approvedMomsuppgift: momsuppgift,
  })
  const approvedIdentity = vatSubmissionIdentity({
    redovisare,
    redovisningsperiod,
    period: declaration.period,
    approvedRutor,
    approvedMomsuppgift: rutorToMomsuppgift(approvedRutor),
  })
  assertSameVatSubmissionIdentity(identity, approvedIdentity)

  const accountTotals = new Map(
    Object.entries(declaration.rcInputAccountTotals ?? {}),
  )
  let checks = runVatDeclarationChecks(declaration.rutor, accountTotals)
  let scan: RcBasisGapScan
  try {
    const gaps = await findRcBasisGaps(
      supabase,
      companyId,
      input.periodType,
      input.year,
      input.period,
      { fiscalPeriodId: input.fiscalPeriodId },
    )
    scan = { status: 'scanned', gapCount: gaps.length }
  } catch {
    scan = { status: 'unavailable' }
  }
  checks = withRcBasisGapFindings(
    checks,
    scan,
    declaration.rcBasisByRate
      ? {
          rutor: declaration.rutor,
          rcBasisByRate: declaration.rcBasisByRate,
          rcInputAccountTotals: accountTotals,
        }
      : undefined,
  )
  if (isFilingBlocked(checks)) {
    throw new VatSubmissionConflictError(
      `VAT filing checks failed: ${checks.filter((check) => check.status === 'ERROR').map((check) => check.code).join(', ')}`,
    )
  }

  return {
    redovisare,
    redovisningsperiod,
    momsuppgift,
    rutor: declaration.rutor,
    period: declaration.period,
    identity,
  }
}

/**
 * Load the AGI XML for a salary run from agi_declarations.xml_content
 * (built by app/api/salary/runs/[id]/agi/xml/route.ts via generateAGIXml),
 * alongside the formatted arbetsgivare/period strings used downstream by the
 * granskningsunderlag and kvittenser calls.
 *
 * Body lifted verbatim from the former loadAGIXml: including the salary-run
 * status guard (per BFL 5 kap and SFL 26 kap, AGI must reflect finalised
 * payroll data; submitting from a draft/cancelled run would emit incorrect
 * figures and require a costly rättelse).
 */
export async function buildAgiUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<AgiUnderlagPrep> {
  if (!salaryRunId) {
    throw new Error('Saknar obligatoriskt fält: salaryRunId')
  }

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('status')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    throw new Error('Lönekörning hittades inte')
  }

  if (!['review', 'approved', 'paid', 'booked'].includes(run.status)) {
    throw new Error('AGI kan bara skickas till Skatteverket efter granskning')
  }

  const arbetsgivare = await resolveRedovisare(supabase, companyId)

  // Use the most recent agi_declarations row for this salary run: covers
  // both new declarations and corrections (which overwrite xml_content
  // in place per the existing /api/salary/runs/[id]/agi/xml route).
  const { data: declaration, error: declarationError } = await supabase
    .from('agi_declarations')
    .select('xml_content, period_year, period_month')
    .eq('company_id', companyId)
    .eq('salary_run_id', salaryRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (declarationError || !declaration?.xml_content) {
    throw new Error(
      'AGI-XML saknas. Generera AGI-filen först: knappen "Lämna in till Skatteverket" på lönekörningen gör det automatiskt, eller klicka "Ladda ner AGI-fil".',
    )
  }

  const period = formatRedovisningsperiod('monthly', declaration.period_year, declaration.period_month)

  return {
    arbetsgivare,
    period,
    salaryRunId,
    xml: declaration.xml_content,
    periodYear: declaration.period_year,
    periodMonth: declaration.period_month,
  }
}
