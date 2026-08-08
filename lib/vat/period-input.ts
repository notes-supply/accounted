import type { VatPeriodType } from '@/types'

export const VAT_PERIOD_MIN_YEAR = 2000
export const VAT_PERIOD_MAX_YEAR = 2100

export type ValidVatPeriodInput = {
  periodType: VatPeriodType
  year: number
  period: number
}

export class VatPeriodInputError extends Error {
  constructor(
    readonly field: 'period_type' | 'year' | 'period',
    message: string,
  ) {
    super(message)
    this.name = 'VatPeriodInputError'
  }
}

function strictInteger(value: unknown, field: 'year' | 'period'): number {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value
    throw new VatPeriodInputError(field, `${field} must be an integer`)
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }

  throw new VatPeriodInputError(field, `${field} must be an integer`)
}

/**
 * Parse one public VAT period contract without permissive numeric coercion.
 * Plain decimal query strings are accepted, while fractions, exponents,
 * partial strings, non-finite values, and unsafe integers are rejected.
 */
export function parseVatPeriodInput(input: {
  periodType: unknown
  year: unknown
  period: unknown
}): ValidVatPeriodInput {
  const { periodType } = input
  if (periodType !== 'monthly' && periodType !== 'quarterly' && periodType !== 'yearly') {
    throw new VatPeriodInputError(
      'period_type',
      'period_type must be: monthly, quarterly, yearly',
    )
  }

  const year = strictInteger(input.year, 'year')
  if (year < VAT_PERIOD_MIN_YEAR || year > VAT_PERIOD_MAX_YEAR) {
    throw new VatPeriodInputError(
      'year',
      `year must be between ${VAT_PERIOD_MIN_YEAR} and ${VAT_PERIOD_MAX_YEAR}`,
    )
  }

  const period = strictInteger(input.period, 'period')
  if (periodType === 'monthly' && (period < 1 || period > 12)) {
    throw new VatPeriodInputError('period', 'period must be 1-12 for monthly')
  }
  if (periodType === 'quarterly' && (period < 1 || period > 4)) {
    throw new VatPeriodInputError('period', 'period must be 1-4 for quarterly')
  }
  if (periodType === 'yearly' && period !== 1) {
    throw new VatPeriodInputError('period', 'period must be 1 for yearly')
  }

  return { periodType, year, period }
}
