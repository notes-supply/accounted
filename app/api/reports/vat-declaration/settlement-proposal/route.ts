import { NextResponse } from 'next/server'
import { buildVatSettlementProposal } from '@/lib/reports/vat-settlement'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { VatPeriodType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { parseVatPeriodInput, VatPeriodInputError } from '@/lib/vat/period-input'

/**
 * GET /api/reports/vat-declaration/settlement-proposal
 *
 * Builds the momsredovisning verifikat proposal for a VAT period (issue #980):
 * the editable lines that clear the period's 26xx accounts to 2650/1650. The
 * proposal is computed from the same ledger projection as the momsrapport;
 * booking happens separately through POST /api/bookkeeping/journal-entries
 * with source_type 'vat_settlement' once the user has reviewed the lines.
 *
 * Query parameters (same shape as /api/reports/vat-declaration):
 *   periodType:       'monthly' | 'quarterly' | 'yearly'
 *   year:             number (e.g., 2026)
 *   period:           number (1-12 monthly, 1-4 quarterly, 1 yearly)
 *   fiscal_period_id: optional; yearly only (räkenskapsår bounds)
 */
export const GET = withRouteContext(
  'report.vat_settlement_proposal',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearStr || !periodStr) {
      return errorResponseFromCode('VAT_REPORT_MISSING_PARAMS', log, { requestId })
    }

    if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD_TYPE', log, {
        requestId,
        details: { received: periodType },
      })
    }

    let parsedPeriod: ReturnType<typeof parseVatPeriodInput>
    try {
      parsedPeriod = parseVatPeriodInput({ periodType, year: yearStr, period: periodStr })
    } catch (error) {
      const code = error instanceof VatPeriodInputError && error.field === 'year'
        ? 'VAT_REPORT_INVALID_YEAR'
        : 'VAT_REPORT_INVALID_PERIOD'
      return errorResponseFromCode(code, log, {
        requestId,
        details: { periodType, received: periodStr },
      })
    }
    const { year, period } = parsedPeriod

    try {
      const proposal = await buildVatSettlementProposal(
        supabase, companyId!, periodType, year, period, { fiscalPeriodId },
      )
      return NextResponse.json({ data: proposal })
    } catch (err) {
      log.error('vat settlement proposal failed', err as Error, {
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
