import {
  CommerceSyncPersistenceError,
  CommerceSyncTimeoutError,
  type CommerceSyncTotals,
} from './order-sync-errors'

interface AbortablePromiseLike<T> extends PromiseLike<T> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

export function canonicalInstant(value: string, label = 'timestamp'): string {
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) throw new Error(`Invalid ${label}`)
  return new Date(instant).toISOString()
}

export function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right)
}

export function deadlineReached(deadlineMs?: number): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs
}

export async function awaitCommerceOperation<T>(
  operation: AbortablePromiseLike<T>,
  deadlineMs: number | undefined,
  label: string,
): Promise<T> {
  if (deadlineMs === undefined) return await operation
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new CommerceSyncTimeoutError(`${label} timed out`)

  const controller = new AbortController()
  const bounded = operation.abortSignal
    ? operation.abortSignal(controller.signal)
    : operation
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(bounded),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new CommerceSyncTimeoutError(`${label} timed out`))
        }, remainingMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export async function awaitDurableCommerceOperation<
  T,
  TSummary extends CommerceSyncTotals,
>(
  operation: AbortablePromiseLike<T>,
  deadlineMs: number | undefined,
  label: string,
  operationName: string,
  summary: TSummary,
): Promise<T> {
  try {
    return await awaitCommerceOperation(operation, deadlineMs, label)
  } catch (error) {
    if (error instanceof CommerceSyncPersistenceError) throw error
    throw new CommerceSyncPersistenceError(
      `${label} did not reach a confirmed outcome`,
      operationName,
      summary,
      { cause: error },
    )
  }
}
