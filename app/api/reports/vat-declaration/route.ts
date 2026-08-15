import { NextResponse } from 'next/server'
import {
  calculateVatDeclaration,
  formatPeriodLabel,
  parseVatPeriodInput,
  type VatPeriodInput,
} from '@/lib/reports/vat-declaration'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { FISCAL_YEAR_RE } from '@/lib/invariants'

/**
 * GET /api/reports/vat-declaration
 *
 * Query parameters:
 *   periodType: 'monthly' | 'quarterly' | 'yearly'
 *   year:       number (e.g., 2025)
 *   period:     number (1-12 for monthly, 1-4 for quarterly, 1 for yearly)
 */
export const GET = withRouteContext(
  'report.vat_declaration',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType')
    const yearInput = searchParams.get('year')
    const periodInput = searchParams.get('period')
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearInput || !periodInput) {
      return errorResponseFromCode('VAT_REPORT_MISSING_PARAMS', log, { requestId })
    }

    let parsed: VatPeriodInput
    try {
      parsed = parseVatPeriodInput({
        periodType,
        year: yearInput,
        period: periodInput,
        fiscalPeriodId,
      })
    } catch (error) {
      const code = !['monthly', 'quarterly', 'yearly'].includes(periodType)
        ? 'VAT_REPORT_INVALID_PERIOD_TYPE'
        : !FISCAL_YEAR_RE.test(yearInput)
            || Number(yearInput) < 2000
            || Number(yearInput) > 2100
          ? 'VAT_REPORT_INVALID_YEAR'
          : 'VAT_REPORT_INVALID_PERIOD'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { received: error instanceof Error ? error.message : 'invalid' },
      })
    }

    const { year, period } = parsed

    try {
      // Accounting method is already reflected in journal entry timing.
      const declaration = await calculateVatDeclaration(
        supabase, companyId!, parsed.periodType, year, period,
        { fiscalPeriodId: parsed.fiscalPeriodId },
      )

      return NextResponse.json({
        data: {
          ...declaration,
          // For yearly the authoritative span is declaration.period.start/end
          // (the räkenskapsår). The label stays a coarse "Helår {year}".
          periodLabel: formatPeriodLabel(parsed.periodType, year, period),
        },
      })
    } catch (err) {
      log.error('vat declaration calculation failed', err as Error, {
        periodType,
        year,
        period,
      })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
