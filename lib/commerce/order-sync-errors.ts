export interface CommerceSyncTotals {
  fetched: number
  refundsFetched: number
  imported: number
  duplicates: number
  skippedLocked: number
  errors: number
  deadlineReached?: boolean
  revoked?: boolean
}

/**
 * A durable queue or progress write whose outcome cannot be treated as an
 * ordinary provider failure. Callers must return non-2xx and retain summary
 * totals because transaction ingestion may already have completed.
 */
export class CommerceSyncPersistenceError<
  TSummary extends CommerceSyncTotals = CommerceSyncTotals,
> extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly summary?: TSummary,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CommerceSyncPersistenceError'
  }
}

export class CommerceSyncTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommerceSyncTimeoutError'
  }
}

export class CommerceSyncProviderError<
  TSummary extends CommerceSyncTotals = CommerceSyncTotals,
> extends Error {
  constructor(
    message: string,
    readonly summary: TSummary,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CommerceSyncProviderError'
  }
}

export function durableSyncFailureSummary<TSummary extends CommerceSyncTotals>(
  error: unknown,
): TSummary | undefined {
  return error instanceof CommerceSyncPersistenceError
    ? (error.summary as TSummary | undefined)
    : undefined
}

export function commerceSyncFailureSummary<TSummary extends CommerceSyncTotals>(
  error: unknown,
): TSummary | undefined {
  if (error instanceof CommerceSyncPersistenceError) {
    return error.summary as TSummary | undefined
  }
  if (error instanceof CommerceSyncProviderError) {
    return error.summary as TSummary
  }
  return undefined
}
