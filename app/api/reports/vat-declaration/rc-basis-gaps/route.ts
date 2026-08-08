import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findRcBasisGaps } from '@/lib/reports/rc-basis-gaps'
import type { VatPeriodType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { parseVatPeriodInput } from '@/lib/vat/period-input'

export const GET = withRouteContext(
  'report.vat_declaration.rc_basis_gaps',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // Yearly (helårsmoms) resolves against the räkenskapsår, mirroring the
    // declaration route; monthly/quarterly ignore it.
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
    } catch {
      return errorResponseFromCode('VAT_REPORT_INVALID_PERIOD', log, {
        requestId,
        details: { year: yearStr, period: periodStr },
      })
    }
    const { year, period } = parsedPeriod

    try {
      const gaps = await findRcBasisGaps(supabase, companyId, periodType, year, period, {
        fiscalPeriodId,
      })
      return NextResponse.json({ data: { gaps } })
    } catch (err) {
      log.error('rc-basis-gaps detection failed', err as Error, { periodType, year, period })
      return errorResponseFromCode('VAT_REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
