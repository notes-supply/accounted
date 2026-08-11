import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import type { CapabilityKey } from '@/lib/entitlements/keys'
import type { Logger } from '@/lib/logger'
import {
  CommerceSyncPersistenceError,
  CommerceSyncTimeoutError,
} from './order-sync-errors'

export const COMMERCE_CONNECTION_PAGE_SIZE = 100
export const COMMERCE_ELIGIBLE_CONNECTION_LIMIT = 50
export const COMMERCE_CLAIM_LEASE_MS = 10 * 60 * 1000
const RELEASE_ATTEMPTS = 3

export type CommerceConnectionTable = 'shopify_connections' | 'woocommerce_connections'

export interface SchedulableCommerceConnection {
  id: string
  company_id: string
  order_sync_priority_at: string
  order_sync_claim_token?: string | null
  order_sync_claimed_until?: string | null
}

export interface ClaimedCommerceConnection<T extends SchedulableCommerceConnection> {
  connection: T
  claimToken: string
  previousPriorityAt: string
}

interface ClaimOptions {
  supabase: SupabaseClient
  table: CommerceConnectionTable
  capability: CapabilityKey
  selectionDeadlineMs: number
  cleanupDeadlineMs?: number
  log: Logger
}

export interface ClaimSelection<T extends SchedulableCommerceConnection> {
  claims: Array<ClaimedCommerceConnection<T>>
  foundAnyConnection: boolean
  timedOut: boolean
}

interface AbortablePromiseLike<T> extends PromiseLike<T> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

function availableClaimFilter(nowIso: string): string {
  return `order_sync_claimed_until.is.null,order_sync_claimed_until.lt.${nowIso}`
}

function providerForTable(table: CommerceConnectionTable): 'shopify' | 'woocommerce' {
  return table === 'shopify_connections' ? 'shopify' : 'woocommerce'
}

async function awaitBefore<T>(
  operation: AbortablePromiseLike<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now()
  if (remainingMs <= 0) throw new CommerceSyncTimeoutError(`${label} timed out`)

  const controller = new AbortController()
  const boundedOperation = operation.abortSignal
    ? operation.abortSignal(controller.signal)
    : operation
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(boundedOperation),
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

function claimedConnection<T extends SchedulableCommerceConnection>(
  connection: T,
  claimToken: string,
  claimedUntilIso: string,
): T {
  return {
    ...connection,
    order_sync_claim_token: claimToken,
    order_sync_claimed_until: claimedUntilIso,
  }
}

function potentialClaim<T extends SchedulableCommerceConnection>(
  connection: T,
  claimToken: string,
  claimedUntilIso: string,
): ClaimedCommerceConnection<T> {
  return {
    connection: claimedConnection(connection, claimToken, claimedUntilIso),
    claimToken,
    previousPriorityAt: connection.order_sync_priority_at,
  }
}

async function restoreClaimOnce<T extends SchedulableCommerceConnection>(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  claim: ClaimedCommerceConnection<T>,
  deadlineMs: number,
): Promise<void> {
  const query = supabase.rpc('restore_commerce_order_sync_claim', {
    p_provider: providerForTable(table),
    p_connection_id: claim.connection.id,
    p_claim_token: claim.claimToken,
    p_previous_priority_at: claim.previousPriorityAt,
  })
  const { data, error } = await awaitBefore(
    query,
    deadlineMs,
    `restore commerce sync claim ${claim.connection.id}`,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to restore commerce sync claim${error ? `: ${error.message}` : ': exact claim token was not restored'}`,
      'claim_restore',
    )
  }
}

async function restoreUnstartedClaims<T extends SchedulableCommerceConnection>(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  claims: Array<ClaimedCommerceConnection<T>>,
  deadlineMs: number,
): Promise<void> {
  const results = await Promise.allSettled(
    claims.map(claim => restoreClaimOnce(supabase, table, claim, deadlineMs)),
  )
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [`${claims[index].connection.id}: ${String(result.reason)}`]
      : [],
  )
  if (failures.length > 0) {
    throw new CommerceSyncPersistenceError(
      `Failed to restore unstarted commerce sync claims: ${failures.join(', ')}`,
      'claim_restore',
    )
  }
}

async function rotateIneligibleConnection<T extends SchedulableCommerceConnection>(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  connection: T,
  deadlineMs: number,
): Promise<void> {
  const previousPriorityMs = Date.parse(connection.order_sync_priority_at)
  const rotatedAtMs = Number.isFinite(previousPriorityMs)
    ? Math.max(Date.now(), previousPriorityMs + 1)
    : Date.now()
  const query = supabase.rpc('rotate_ineligible_commerce_order_sync_connection', {
    p_provider: providerForTable(table),
    p_connection_id: connection.id,
    p_expected_priority_at: connection.order_sync_priority_at,
    p_rotated_at: new Date(rotatedAtMs).toISOString(),
  })
  const { data, error } = await awaitBefore(
    query,
    deadlineMs,
    `rotate ineligible commerce sync connection ${connection.id}`,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to rotate ineligible commerce sync connection${error ? `: ${error.message}` : ': exact priority was not matched'}`,
      'ineligible_priority_rotation',
    )
  }
}

/**
 * Atomically claim one known active connection for a manual sync. Unlike cron
 * selection, this intentionally ignores transaction_sync_enabled: pressing
 * the manual sync button is the opt-in. The same priority rotation and
 * tokenized lease CAS prevent overlap with cron and other manual requests.
 */
export async function claimCommerceOrderSyncConnection<
  T extends SchedulableCommerceConnection,
>(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  connection: T,
  deadlineMs = Date.now() + 30_000,
  cleanupDeadlineMs = deadlineMs + 30_000,
): Promise<ClaimedCommerceConnection<T> | null> {
  const claimToken = randomUUID()
  const claimedAtMs = Date.now()
  const claimedAtIso = new Date(claimedAtMs).toISOString()
  const claimedUntilIso = new Date(claimedAtMs + COMMERCE_CLAIM_LEASE_MS).toISOString()
  const possibleClaim = potentialClaim(connection, claimToken, claimedUntilIso)

  const query = supabase.rpc('claim_commerce_order_sync_connection', {
    p_provider: providerForTable(table),
    p_connection_id: connection.id,
    p_expected_priority_at: connection.order_sync_priority_at,
    p_claim_token: claimToken,
    p_claimed_at: claimedAtIso,
    p_claimed_until: claimedUntilIso,
    p_require_sync_enabled: false,
  })

  let result: Awaited<typeof query>
  try {
    result = await awaitBefore(query, deadlineMs, `claim commerce sync connection ${connection.id}`)
  } catch (error) {
    try {
      await restoreUnstartedClaims(supabase, table, [possibleClaim], cleanupDeadlineMs)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Commerce sync claim timed out and its exact-token cleanup failed',
      )
    }
    throw error
  }
  if (result.error) {
    throw new CommerceSyncPersistenceError(
      `Failed to claim commerce sync connection: ${result.error.message}`,
      'claim',
    )
  }
  if (result.data !== true) return null

  if (Date.now() >= deadlineMs) {
    await restoreUnstartedClaims(supabase, table, [possibleClaim], cleanupDeadlineMs)
    throw new CommerceSyncTimeoutError(`claim commerce sync connection ${connection.id} completed too late`)
  }
  return possibleClaim
}

/**
 * Select and atomically claim a fair, restart-safe cron batch.
 *
 * The keyset is the durable scheduling priority, not the mutable provider
 * cursor. Claiming moves a row behind unattempted rows and places a tokenized
 * lease on it. Cross-page movement can therefore cause a harmless duplicate
 * observation, handled by seenConnectionIds, but cannot cause an unclaimed
 * row before the keyset to disappear silently: another invocation owns it.
 */
export async function claimCommerceOrderSyncConnections<
  T extends SchedulableCommerceConnection,
>(options: ClaimOptions): Promise<ClaimSelection<T>> {
  const { supabase, table, capability, selectionDeadlineMs, log } = options
  const cleanupDeadlineMs = options.cleanupDeadlineMs ?? selectionDeadlineMs + 30_000
  const claims: Array<ClaimedCommerceConnection<T>> = []
  const capabilityByCompany = new Map<string, boolean>()
  const seenConnectionIds = new Set<string>()
  let lastPriorityAt: string | null = null
  let lastId: string | null = null
  let foundAnyConnection = false

  const timeoutSelection = async (
    possibleClaim?: ClaimedCommerceConnection<T>,
  ): Promise<ClaimSelection<T>> => {
    await restoreUnstartedClaims(
      supabase,
      table,
      possibleClaim ? [...claims, possibleClaim] : claims,
      cleanupDeadlineMs,
    )
    return { claims: [], foundAnyConnection, timedOut: true }
  }

  try {
    while (claims.length < COMMERCE_ELIGIBLE_CONNECTION_LIMIT) {
      if (Date.now() >= selectionDeadlineMs) return await timeoutSelection()

      const scanNowIso = new Date(Date.now()).toISOString()
      let query = supabase
        .from(table)
        .select('*')
        .eq('status', 'active')
        .eq('transaction_sync_enabled', true)
        .or(availableClaimFilter(scanNowIso))
        .order('order_sync_priority_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(COMMERCE_CONNECTION_PAGE_SIZE)

      if (lastPriorityAt !== null && lastId !== null) {
        query = query.or(
          `order_sync_priority_at.gt.${lastPriorityAt},and(order_sync_priority_at.eq.${lastPriorityAt},id.gt.${lastId})`,
        )
      }

      const { data, error } = await awaitBefore(
        query,
        selectionDeadlineMs,
        `select ${table} sync candidates`,
      )
      if (error) throw error
      if (Date.now() >= selectionDeadlineMs) return await timeoutSelection()

      const page = (data ?? []) as T[]
      if (page.length === 0) break
      foundAnyConnection = true
      const tail = page[page.length - 1]
      lastPriorityAt = tail.order_sync_priority_at
      lastId = tail.id

      const unseenPage = page.filter(connection => {
        if (seenConnectionIds.has(connection.id)) return false
        seenConnectionIds.add(connection.id)
        return true
      })
      const unseenCompanyIds = [
        ...new Set(
          unseenPage
            .map(connection => connection.company_id)
            .filter(companyId => !capabilityByCompany.has(companyId)),
        ),
      ]

      if (unseenCompanyIds.length > 0) {
        const entitlementController = new AbortController()
        const entitlementPromise = getCompanyIdsWithCapability(
          supabase,
          unseenCompanyIds,
          capability,
          { signal: entitlementController.signal, deadlineMs: selectionDeadlineMs },
        )
        let entitledCompanyIds: Set<string>
        try {
          entitledCompanyIds = await awaitBefore(
            entitlementPromise,
            selectionDeadlineMs,
            `resolve ${table} entitlements`,
          )
        } catch (error) {
          entitlementController.abort()
          throw error
        }
        if (Date.now() >= selectionDeadlineMs) return await timeoutSelection()
        for (const companyId of unseenCompanyIds) {
          capabilityByCompany.set(companyId, entitledCompanyIds.has(companyId))
        }
      }

      for (const connection of unseenPage) {
        if (!capabilityByCompany.get(connection.company_id)) {
          log.info('skip: capability not entitled', { companyId: connection.company_id })
          await rotateIneligibleConnection(
            supabase,
            table,
            connection,
            selectionDeadlineMs,
          )
          if (Date.now() >= selectionDeadlineMs) return await timeoutSelection()
          continue
        }
        if (Date.now() >= selectionDeadlineMs) return await timeoutSelection()

        const claimToken = randomUUID()
        const claimedAtMs = Date.now()
        const claimedAtIso = new Date(claimedAtMs).toISOString()
        const claimedUntilIso = new Date(claimedAtMs + COMMERCE_CLAIM_LEASE_MS).toISOString()
        const possibleClaim = potentialClaim(connection, claimToken, claimedUntilIso)
        const claimQuery = supabase.rpc('claim_commerce_order_sync_connection', {
          p_provider: providerForTable(table),
          p_connection_id: connection.id,
          p_expected_priority_at: connection.order_sync_priority_at,
          p_claim_token: claimToken,
          p_claimed_at: claimedAtIso,
          p_claimed_until: claimedUntilIso,
          p_require_sync_enabled: true,
        })

        let claimResult: Awaited<typeof claimQuery>
        try {
          claimResult = await awaitBefore(
            claimQuery,
            selectionDeadlineMs,
            `claim ${table} connection ${connection.id}`,
          )
        } catch (error) {
          if (error instanceof CommerceSyncTimeoutError) return await timeoutSelection(possibleClaim)
          try {
            await restoreUnstartedClaims(
              supabase,
              table,
              [...claims, possibleClaim],
              cleanupDeadlineMs,
            )
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              'Commerce sync claim failed and its exact-token cleanup failed',
            )
          }
          claims.length = 0
          throw error
        }
        if (claimResult.error) throw claimResult.error
        if (claimResult.data !== true) continue

        if (Date.now() >= selectionDeadlineMs) return await timeoutSelection(possibleClaim)
        claims.push(possibleClaim)
        if (claims.length === COMMERCE_ELIGIBLE_CONNECTION_LIMIT) break
      }

      if (page.length < COMMERCE_CONNECTION_PAGE_SIZE) break
    }
  } catch (error) {
    if (error instanceof CommerceSyncTimeoutError) return await timeoutSelection()
    try {
      await restoreUnstartedClaims(supabase, table, claims, cleanupDeadlineMs)
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Commerce sync selection failed and its unstarted claims could not be restored',
      )
    }
    throw error
  }

  return { claims, foundAnyConnection, timedOut: false }
}

/** Clear exactly this invocation's lease. A stale invocation cannot release a newer claim. */
export async function releaseCommerceOrderSyncClaim(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  connectionId: string,
  claimToken: string,
  deadlineMs = Date.now() + 30_000,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
    try {
      const query = supabase.rpc('release_commerce_order_sync_claim', {
        p_provider: providerForTable(table),
        p_connection_id: connectionId,
        p_claim_token: claimToken,
      })
      const { data, error } = await awaitBefore(
        query,
        deadlineMs,
        `release commerce sync claim ${connectionId}`,
      )
      if (error) throw new Error(error.message)
      if (data !== true) {
        throw new CommerceSyncPersistenceError(
          `Failed to release commerce sync claim for ${connectionId}: exact claim token was not released`,
          'claim_release',
        )
      }
      return
    } catch (error) {
      lastError = error
      if (error instanceof CommerceSyncPersistenceError || Date.now() >= deadlineMs) break
    }
  }
  throw lastError instanceof CommerceSyncPersistenceError
    ? lastError
    : new CommerceSyncPersistenceError(
        `Failed to release commerce sync claim for ${connectionId}`,
        'claim_release',
        undefined,
        { cause: lastError },
      )
}

/** Restore queue position when a claimed connection never reached provider work. */
export async function restoreCommerceOrderSyncClaim(
  supabase: SupabaseClient,
  table: CommerceConnectionTable,
  claim: ClaimedCommerceConnection<SchedulableCommerceConnection>,
  deadlineMs = Date.now() + 30_000,
): Promise<void> {
  const query = supabase.rpc('restore_commerce_order_sync_claim', {
    p_provider: providerForTable(table),
    p_connection_id: claim.connection.id,
    p_claim_token: claim.claimToken,
    p_previous_priority_at: claim.previousPriorityAt,
  })
  const { data, error } = await awaitBefore(
    query,
    deadlineMs,
    `restore commerce sync claim ${claim.connection.id}`,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to restore commerce sync claim${error ? `: ${error.message}` : ': exact claim token was not restored'}`,
      'claim_restore',
    )
  }
}
