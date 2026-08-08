/**
 * Extract the one stable failure payload HTTP callers may act on.
 * Executor result.data can contain operation-specific internals; routes must
 * never spread it into public responses.
 */
export function extractPartialPostedIds(
  data: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const candidate = data?.posted_ids
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined
  }

  const entries = Object.entries(candidate).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].length > 0,
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export interface PublicPartialFailureState {
  persistence: 'confirmed' | 'database_error' | 'conflict'
  operation_status: 'failed_partial' | 'committing' | 'other' | 'unknown'
}

/** Whitelist the stable persistence state without exposing executor internals. */
export function extractPartialFailureState(
  data: Record<string, unknown> | undefined,
): PublicPartialFailureState | undefined {
  const candidate = data?.partial_failure_state
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined
  }

  const persistence = (candidate as Record<string, unknown>).persistence
  const operationStatus = (candidate as Record<string, unknown>).operation_status
  if (
    !['confirmed', 'database_error', 'conflict'].includes(String(persistence)) ||
    !['failed_partial', 'committing', 'other', 'unknown'].includes(String(operationStatus))
  ) {
    return undefined
  }

  return {
    persistence: persistence as PublicPartialFailureState['persistence'],
    operation_status: operationStatus as PublicPartialFailureState['operation_status'],
  }
}
