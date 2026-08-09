import type { FiscalPeriod, VatPeriodType } from '@/types'

export interface VatFiscalPeriodSelection {
  id: string
  periodEnd: string
}

export interface VatReportRequest {
  periodType: VatPeriodType
  year: number
  period: number
  fiscalPeriodId?: string
}

function isExactIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
}

/**
 * Accept only evidence returned for the exact selected picker id. A missing,
 * stale, or malformed picker row must not produce an annual report request.
 */
export function selectVatFiscalPeriod(
  expectedCompanyId: string | null,
  selectedId: string | null,
  fiscalPeriod?: Pick<FiscalPeriod, 'id' | 'company_id' | 'period_end'> | null,
): VatFiscalPeriodSelection | null {
  if (
    !expectedCompanyId ||
    !selectedId ||
    !fiscalPeriod ||
    fiscalPeriod.company_id !== expectedCompanyId ||
    fiscalPeriod.id !== selectedId ||
    !isExactIsoDate(fiscalPeriod.period_end)
  ) {
    return null
  }
  return { id: selectedId, periodEnd: fiscalPeriod.period_end }
}

/**
 * Build the one period identity used by every VAT dashboard request.
 * Annual requests derive their compatibility year from the authoritative
 * fiscal period end; monthly and quarterly requests remain calendar-based.
 */
export function buildVatReportRequest(
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriod: VatFiscalPeriodSelection | null,
): VatReportRequest | null {
  if (periodType !== 'yearly') return { periodType, year, period }
  if (!fiscalPeriod) return null
  return {
    periodType,
    year: Number(fiscalPeriod.periodEnd.slice(0, 4)),
    period: 1,
    fiscalPeriodId: fiscalPeriod.id,
  }
}

export function vatReportRequestQuery(request: VatReportRequest): string {
  const params = new URLSearchParams({
    periodType: request.periodType,
    year: String(request.year),
    period: String(request.period),
  })
  if (request.fiscalPeriodId) {
    params.set('fiscal_period_id', request.fiscalPeriodId)
  }
  return params.toString()
}
