import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getCompanyIdsWithCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) =>
    getCompanyIdsWithCapability(...args),
}))

import {
  claimCommerceOrderSyncConnection,
  claimCommerceOrderSyncConnections,
  releaseCommerceOrderSyncClaim,
} from '../order-sync-scheduler'
import type { Logger } from '@/lib/logger'

interface Row {
  id: string
  company_id: string
  order_sync_priority_at: string
}

const PRIORITY = '1970-01-01T00:00:00.000Z'
const log = { info: vi.fn() } as unknown as Logger

function rows(count: number, companyId: string, prefix: string): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index + 1).padStart(3, '0')}`,
    company_id: companyId,
    order_sync_priority_at: PRIORITY,
  }))
}

function makeClient(
  pages: Row[][],
  options: {
    unclaimableIds?: Set<string>
    neverClaimIds?: Set<string>
    lateClaimIds?: Set<string>
    rejectAfterClaimIds?: Set<string>
    claimErrorIds?: Set<string>
    neverSelect?: boolean
    neverRestore?: boolean
    restoreFalse?: boolean
    releaseErrorAttempts?: number
    releaseFalse?: boolean
    releaseResponseLost?: boolean
    onClaimResolved?: () => void
  } = {},
  sharedClaims = new Map<string, { token: string; priority: string }>(),
) {
  const claimedIds: string[] = []
  const cancellations = new Set<string>()
  const lateClaims = new Map<string, () => void>()
  const updates: Array<{
    id: string
    values: Record<string, unknown>
    filters: Record<string, unknown>
  }> = []
  let pageIndex = 0
  const client = {
    from() {
      let operation: 'select' | 'update' | null = null
      let values: Record<string, unknown> = {}
      const filters = new Map<string, unknown>()
      const builder = {
        select: () => {
          if (operation === null) operation = 'select'
          return builder
        },
        update: (nextValues: Record<string, unknown>) => {
          operation = 'update'
          values = nextValues
          return builder
        },
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return builder
        },
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const id = String(filters.get('id'))
          updates.push({ id, values, filters: Object.fromEntries(filters) })
          if (
            values.order_sync_claim_token &&
            options.unclaimableIds?.has(id)
          ) {
            return { data: null, error: null }
          }
          if (values.order_sync_claim_token) claimedIds.push(id)
          return { data: { id }, error: null }
        },
        then: (
          resolve: (value: { data: Row[]; error: null }) => void,
        ) => {
          if (options.neverSelect) return
          resolve({ data: pages[pageIndex++] ?? [], error: null })
        },
      }
      return builder
    },
    rpc(name: string, args: Record<string, unknown>) {
      const id = String(args.p_connection_id)
      if (name === 'claim_commerce_order_sync_connection') {
        updates.push({
          id,
          values: {
            order_sync_claim_token: args.p_claim_token,
            order_sync_claimed_until: args.p_claimed_until,
            order_sync_priority_at: args.p_claimed_at,
          },
          filters: {
            status: 'active',
            order_sync_priority_at: args.p_expected_priority_at,
            transaction_sync_enabled: args.p_require_sync_enabled,
          },
        })
        if (options.unclaimableIds?.has(id) || sharedClaims.has(id)) {
          return Promise.resolve({ data: false, error: null })
        }
        if (options.claimErrorIds?.has(id)) {
          return Promise.resolve({ data: null, error: { message: 'claim failed' } })
        }
        const token = String(args.p_claim_token)
        const cancellationKey = `${id}:${token}`
        if (cancellations.has(cancellationKey)) {
          return Promise.resolve({ data: false, error: null })
        }
        if (options.lateClaimIds?.has(id)) {
          return new Promise(resolve => {
            lateClaims.set(cancellationKey, () => {
              if (cancellations.has(cancellationKey)) {
                resolve({ data: false, error: null })
                return
              }
              sharedClaims.set(id, {
                token,
                priority: String(args.p_expected_priority_at),
              })
              claimedIds.push(id)
              resolve({ data: true, error: null })
            })
          })
        }
        sharedClaims.set(id, {
          token,
          priority: String(args.p_expected_priority_at),
        })
        claimedIds.push(id)
        if (options.rejectAfterClaimIds?.has(id)) {
          return Promise.reject(new Error('claim response lost'))
        }
        if (options.neverClaimIds?.has(id)) return new Promise(() => undefined)
        options.onClaimResolved?.()
        return Promise.resolve({ data: true, error: null })
      }
      if (name === 'release_commerce_order_sync_claim') {
        if ((options.releaseErrorAttempts ?? 0) > 0) {
          options.releaseErrorAttempts = (options.releaseErrorAttempts ?? 0) - 1
          return Promise.resolve({ data: null, error: { message: 'release unavailable' } })
        }
        if (options.releaseFalse) {
          return Promise.resolve({ data: false, error: null })
        }
        const active = sharedClaims.get(id)
        if (!active) return Promise.resolve({ data: true, error: null })
        if (active.token !== args.p_claim_token) {
          return Promise.resolve({ data: false, error: null })
        }
        sharedClaims.delete(id)
        updates.push({
          id,
          values: {
            order_sync_claim_token: null,
            order_sync_claimed_until: null,
          },
          filters: { order_sync_claim_token: args.p_claim_token },
        })
        if (options.releaseResponseLost) {
          options.releaseResponseLost = false
          return Promise.reject(new Error('release response lost'))
        }
        return Promise.resolve({ data: true, error: null })
      }
      if (name === 'restore_commerce_order_sync_claim') {
        if (options.neverRestore) return new Promise(() => undefined)
        if (options.restoreFalse) return Promise.resolve({ data: false, error: null })
        const cancellationKey = `${id}:${String(args.p_claim_token)}`
        cancellations.add(cancellationKey)
        const active = sharedClaims.get(id)
        if (!active) {
          const finishLateClaim = lateClaims.get(cancellationKey)
          if (finishLateClaim) {
            lateClaims.delete(cancellationKey)
            queueMicrotask(finishLateClaim)
          }
          return Promise.resolve({ data: true, error: null })
        }
        if (active.token !== args.p_claim_token) {
          return Promise.resolve({ data: false, error: null })
        }
        sharedClaims.delete(id)
        updates.push({
          id,
          values: {
            order_sync_priority_at: args.p_previous_priority_at,
            order_sync_claim_token: null,
            order_sync_claimed_until: null,
          },
          filters: { order_sync_claim_token: args.p_claim_token },
        })
        return Promise.resolve({ data: true, error: null })
      }
      if (name === 'rotate_ineligible_commerce_order_sync_connection') {
        updates.push({
          id,
          values: { order_sync_priority_at: args.p_rotated_at },
          filters: { order_sync_priority_at: args.p_expected_priority_at },
        })
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    client: client as unknown as SupabaseClient,
    claimedIds,
    updates,
    sharedClaims,
    cancellations,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCompanyIdsWithCapability.mockImplementation(
    async (_client: unknown, companyIds: string[]) =>
      new Set(companyIds.filter(companyId => companyId.startsWith('eligible'))),
  )
})

describe('commerce order sync scheduler', () => {
  it('returns a conflict when a manual single-connection claim loses the lease CAS', async () => {
    const connection = rows(1, 'eligible-company', 'manual')[0]
    const { client, claimedIds, updates } = makeClient([], {
      unclaimableIds: new Set([connection.id]),
    })

    const claim = await claimCommerceOrderSyncConnection(
      client,
      'woocommerce_connections',
      connection,
    )

    expect(claim).toBeNull()
    expect(claimedIds).toEqual([])
    expect(updates[0].filters).toMatchObject({
      status: 'active',
      order_sync_priority_at: PRIORITY,
      transaction_sync_enabled: false,
    })
  })

  it('releases a manual claim with exactly its opaque token', async () => {
    const connection = rows(1, 'eligible-company', 'manual')[0]
    const { client, updates } = makeClient([])
    const claim = await claimCommerceOrderSyncConnection(
      client,
      'shopify_connections',
      connection,
    )
    expect(claim).not.toBeNull()

    await releaseCommerceOrderSyncClaim(
      client,
      'shopify_connections',
      connection.id,
      claim!.claimToken,
    )

    expect(updates[1]).toMatchObject({
      id: connection.id,
      values: {
        order_sync_claim_token: null,
        order_sync_claimed_until: null,
      },
      filters: {
        order_sync_claim_token: claim!.claimToken,
      },
    })
  })

  it('cannot release a newer lease from a stale invocation', async () => {
    const sharedClaims = new Map([
      ['manual-001', { token: 'newer-token', priority: PRIORITY }],
    ])
    const { client } = makeClient([], {}, sharedClaims)

    await expect(
      releaseCommerceOrderSyncClaim(
        client,
        'shopify_connections',
        'manual-001',
        'stale-token',
      ),
    ).rejects.toThrow(/Failed to release commerce sync claim for manual-001/)
    expect(sharedClaims.get('manual-001')?.token).toBe('newer-token')
  })

  it('retries a transient release failure and still clears the exact lease', async () => {
    const connection = rows(1, 'eligible-company', 'manual')[0]
    const state = makeClient([], { releaseErrorAttempts: 1 })
    const claim = await claimCommerceOrderSyncConnection(
      state.client,
      'shopify_connections',
      connection,
    )

    await expect(releaseCommerceOrderSyncClaim(
      state.client,
      'shopify_connections',
      connection.id,
      claim!.claimToken,
    )).resolves.toBeUndefined()
    expect(state.sharedClaims.has(connection.id)).toBe(false)
  })

  it('reconciles release response loss after the exact token was cleared', async () => {
    const connection = rows(1, 'eligible-company', 'manual')[0]
    const state = makeClient([], { releaseResponseLost: true })
    const claim = await claimCommerceOrderSyncConnection(
      state.client,
      'shopify_connections',
      connection,
    )

    await expect(releaseCommerceOrderSyncClaim(
      state.client,
      'shopify_connections',
      connection.id,
      claim!.claimToken,
    )).resolves.toBeUndefined()
    expect(state.sharedClaims.has(connection.id)).toBe(false)
  })

  it('fails loudly when release reports that zero exact-token rows changed', async () => {
    const connection = rows(1, 'eligible-company', 'manual')[0]
    const state = makeClient([], { releaseFalse: true })
    const claim = await claimCommerceOrderSyncConnection(
      state.client,
      'shopify_connections',
      connection,
    )

    await expect(releaseCommerceOrderSyncClaim(
      state.client,
      'shopify_connections',
      connection.id,
      claim!.claimToken,
    )).rejects.toThrow(/exact claim token was not released/)
  })

  it('dedupes moved rows, tolerates removal races, and caches entitlement across pages', async () => {
    const first = rows(100, 'lapsed-company', 'old')
    const second = [
      first[98],
      first[99],
      { id: 'removed', company_id: 'eligible-company', order_sync_priority_at: PRIORITY },
      { id: 'eligible-1', company_id: 'eligible-company', order_sync_priority_at: PRIORITY },
      ...rows(96, 'lapsed-company', 'middle'),
    ]
    const third = [
      { id: 'eligible-1', company_id: 'eligible-company', order_sync_priority_at: PRIORITY },
      { id: 'eligible-2', company_id: 'eligible-company', order_sync_priority_at: PRIORITY },
    ]
    const { client, claimedIds } = makeClient([first, second, third], {
      unclaimableIds: new Set(['removed']),
    })

    const selection = await claimCommerceOrderSyncConnections<Row>({
      supabase: client,
      table: 'shopify_connections',
      capability: 'shopify_sync',
      selectionDeadlineMs: Date.now() + 60_000,
      log,
    })

    expect(selection.timedOut).toBe(false)
    expect(claimedIds).toEqual(['eligible-1', 'eligible-2'])
    expect(new Set(claimedIds).size).toBe(claimedIds.length)
    expect(getCompanyIdsWithCapability.mock.calls.map(call => call[1])).toEqual([
      ['lapsed-company'],
      ['eligible-company'],
    ])
  })

  it('rotates 50 failed attempts behind a previously unattempted healthy connection', async () => {
    const failures = rows(50, 'eligible-failing', 'failure')
    const healthy = {
      id: 'healthy',
      company_id: 'eligible-healthy',
      order_sync_priority_at: PRIORITY,
    }
    const firstDb = makeClient([[...failures, healthy]])
    const first = await claimCommerceOrderSyncConnections<Row>({
      supabase: firstDb.client,
      table: 'woocommerce_connections',
      capability: 'woocommerce_sync',
      selectionDeadlineMs: Date.now() + 60_000,
      log,
    })
    expect(first.claims).toHaveLength(50)
    expect(first.claims.some(claim => claim.connection.id === 'healthy')).toBe(false)
    expect(firstDb.updates.every(update => !('last_order_synced_at' in update.values))).toBe(true)
    for (const claim of first.claims) {
      await releaseCommerceOrderSyncClaim(
        firstDb.client,
        'woocommerce_connections',
        claim.connection.id,
        claim.claimToken,
      )
    }

    // The first 50 now carry a later durable priority. The never-attempted
    // healthy row sorts first on the next invocation, even after a restart.
    const rotatedFailures = failures.map(row => ({
      ...row,
      order_sync_priority_at: '2026-08-10T12:00:00.000Z',
    }))
    const secondDb = makeClient([[healthy, ...rotatedFailures]])
    const second = await claimCommerceOrderSyncConnections<Row>({
      supabase: secondDb.client,
      table: 'woocommerce_connections',
      capability: 'woocommerce_sync',
      selectionDeadlineMs: Date.now() + 60_000,
      log,
    })

    expect(second.claims[0].connection.id).toBe('healthy')
  })

  it('bounds a never-settling connection select by the real selection timeout', async () => {
    vi.useFakeTimers()
    try {
      const { client } = makeClient([], { neverSelect: true })
      const selectionPromise = claimCommerceOrderSyncConnections<Row>({
        supabase: client,
        table: 'shopify_connections',
        capability: 'shopify_sync',
        selectionDeadlineMs: Date.now() + 20,
        cleanupDeadlineMs: Date.now() + 40,
        log,
      })

      await vi.advanceTimersByTimeAsync(21)
      await expect(selectionPromise).resolves.toMatchObject({ timedOut: true, claims: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds never-settling entitlement resolution and restores no phantom claims', async () => {
    vi.useFakeTimers()
    try {
      getCompanyIdsWithCapability.mockReturnValueOnce(new Promise(() => undefined))
      const { client, sharedClaims } = makeClient([[rows(1, 'eligible-company', 'entitled')[0]]])
      const selectionPromise = claimCommerceOrderSyncConnections<Row>({
        supabase: client,
        table: 'shopify_connections',
        capability: 'shopify_sync',
        selectionDeadlineMs: Date.now() + 20,
        cleanupDeadlineMs: Date.now() + 40,
        log,
      })

      await vi.advanceTimersByTimeAsync(21)
      await expect(selectionPromise).resolves.toMatchObject({ timedOut: true, claims: [] })
      expect(sharedClaims.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the exact token when claim committed but its response never settles', async () => {
    vi.useFakeTimers()
    try {
      const connection = rows(1, 'eligible-company', 'ambiguous')[0]
      const state = makeClient([[connection]], {
        neverClaimIds: new Set([connection.id]),
      })
      const selectionPromise = claimCommerceOrderSyncConnections<Row>({
        supabase: state.client,
        table: 'woocommerce_connections',
        capability: 'woocommerce_sync',
        selectionDeadlineMs: Date.now() + 20,
        cleanupDeadlineMs: Date.now() + 40,
        log,
      })

      await vi.advanceTimersByTimeAsync(21)
      await expect(selectionPromise).resolves.toMatchObject({ timedOut: true, claims: [] })
      expect(state.sharedClaims.size).toBe(0)
      expect(state.updates.at(-1)?.filters).toMatchObject({
        order_sync_claim_token: expect.any(String),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tombstones an ambiguous token before a late claim can commit', async () => {
    vi.useFakeTimers()
    try {
      const connection = rows(1, 'eligible-company', 'late-commit')[0]
      const state = makeClient([[connection]], {
        lateClaimIds: new Set([connection.id]),
      })
      const selectionPromise = claimCommerceOrderSyncConnections<Row>({
        supabase: state.client,
        table: 'woocommerce_connections',
        capability: 'woocommerce_sync',
        selectionDeadlineMs: Date.now() + 20,
        cleanupDeadlineMs: Date.now() + 40,
        log,
      })

      await vi.advanceTimersByTimeAsync(21)
      await expect(selectionPromise).resolves.toMatchObject({ timedOut: true, claims: [] })
      await vi.runAllTicks()
      expect(state.sharedClaims.size).toBe(0)
      expect(state.cancellations.size).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a successful short-page claim that completes at the deadline', async () => {
    vi.useFakeTimers()
    try {
      const deadlineMs = Date.now() + 20
      const connection = rows(1, 'eligible-company', 'late')[0]
      const state = makeClient([[connection]], {
        onClaimResolved: () => vi.setSystemTime(deadlineMs),
      })

      await expect(claimCommerceOrderSyncConnections<Row>({
        supabase: state.client,
        table: 'shopify_connections',
        capability: 'shopify_sync',
        selectionDeadlineMs: deadlineMs,
        cleanupDeadlineMs: deadlineMs + 20,
        log,
      })).resolves.toMatchObject({ timedOut: true, claims: [] })
      expect(state.sharedClaims.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores partial claims when a later claim errors', async () => {
    const page = rows(2, 'eligible-company', 'partial')
    const state = makeClient([page], { claimErrorIds: new Set([page[1].id]) })

    await expect(claimCommerceOrderSyncConnections<Row>({
      supabase: state.client,
      table: 'woocommerce_connections',
      capability: 'woocommerce_sync',
      selectionDeadlineMs: Date.now() + 60_000,
      cleanupDeadlineMs: Date.now() + 90_000,
      log,
    })).rejects.toThrow(/claim failed/)
    expect(state.sharedClaims.size).toBe(0)
  })

  it('restores the exact possible token when a claim rejects after the CAS wins', async () => {
    const connection = rows(1, 'eligible-company', 'ambiguous-error')[0]
    const state = makeClient([[connection]], {
      rejectAfterClaimIds: new Set([connection.id]),
    })

    await expect(claimCommerceOrderSyncConnections<Row>({
      supabase: state.client,
      table: 'shopify_connections',
      capability: 'shopify_sync',
      selectionDeadlineMs: Date.now() + 60_000,
      cleanupDeadlineMs: Date.now() + 90_000,
      log,
    })).rejects.toThrow(/claim response lost/)
    expect(state.sharedClaims.size).toBe(0)
    expect(state.updates.at(-1)?.filters).toMatchObject({
      order_sync_claim_token: expect.any(String),
    })
  })

  it('bounds never-settling restore cleanup and reports it loudly', async () => {
    vi.useFakeTimers()
    try {
      const connection = rows(1, 'eligible-company', 'cleanup')[0]
      const state = makeClient([[connection]], {
        neverClaimIds: new Set([connection.id]),
        neverRestore: true,
      })
      const selectionPromise = claimCommerceOrderSyncConnections<Row>({
        supabase: state.client,
        table: 'shopify_connections',
        capability: 'shopify_sync',
        selectionDeadlineMs: Date.now() + 20,
        cleanupDeadlineMs: Date.now() + 40,
        log,
      })
      const rejection = expect(selectionPromise).rejects.toThrow(
        /restore unstarted commerce sync claims/,
      )

      await vi.advanceTimersByTimeAsync(41)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
