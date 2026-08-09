import { isSaneDateString } from '@/lib/utils'

export const VAT_PERIOD_BOUNDS_ERROR_CODE = 'VAT_PERIOD_BOUNDS_INVALID'
export const VAT_PERIOD_BOUNDS_DRIFT_CODE = 'VAT_PERIOD_BOUNDS_DRIFT'

export class VatPeriodBoundsError extends Error {
  constructor(
    message: string,
    readonly code: typeof VAT_PERIOD_BOUNDS_ERROR_CODE | typeof VAT_PERIOD_BOUNDS_DRIFT_CODE =
      VAT_PERIOD_BOUNDS_ERROR_CODE,
  ) {
    super(message)
    this.name = 'VatPeriodBoundsError'
  }
}

export interface VatResolvedPeriodBounds {
  start: string
  end: string
}

export function parseOptionalVatResolvedPeriodBounds(
  start: unknown,
  end: unknown,
): VatResolvedPeriodBounds | undefined {
  if (start === undefined && end === undefined) return undefined
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new VatPeriodBoundsError('VAT resolved period bounds must be supplied together')
  }
  if (!isSaneDateString(start) || !isSaneDateString(end)) {
    throw new VatPeriodBoundsError('VAT resolved period bounds must be valid canonical ISO dates')
  }
  if (start > end) {
    throw new VatPeriodBoundsError('VAT resolved period bounds are reversed')
  }
  return { start, end }
}

export function requireVatResolvedPeriodBounds(
  start: unknown,
  end: unknown,
): VatResolvedPeriodBounds {
  const bounds = parseOptionalVatResolvedPeriodBounds(start, end)
  if (!bounds) {
    throw new VatPeriodBoundsError('VAT resolved period bounds are required')
  }
  return bounds
}

export function vatPeriodBoundsDriftError(
  staged: VatResolvedPeriodBounds,
  declaration: VatResolvedPeriodBounds,
): VatPeriodBoundsError {
  return new VatPeriodBoundsError(
    `VAT period changed since staging: staged ${staged.start}..${staged.end}, ` +
      `declaration resolved ${declaration.start}..${declaration.end}`,
    VAT_PERIOD_BOUNDS_DRIFT_CODE,
  )
}

export function isVatPeriodBoundsError(error: unknown): error is VatPeriodBoundsError {
  if (error instanceof VatPeriodBoundsError) return true
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === VAT_PERIOD_BOUNDS_ERROR_CODE || code === VAT_PERIOD_BOUNDS_DRIFT_CODE
}
