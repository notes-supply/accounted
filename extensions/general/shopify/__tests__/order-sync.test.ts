import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()
const createShopifySession = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  createShopifySession: (...args: unknown[]) => createShopifySession(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message === 'REVOKED',
}))

vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: vi.fn(),
}))

vi.mock('@/lib/cash-accounts/service', () => ({
  ensureManualCashAccount: vi.fn().mockResolvedValue('cash-account-1'),
}))

vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))

import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { encryptCredential } from '../lib/credentials'
import {
  SHOPIFY_IMPORT_SOURCE,
  SHOPIFY_LEDGER_ACCOUNT,
  mapOrder,
  mapRefund,
  orderQualifies,
  rowBehindLock,
  shopifyOrderExternalId,
  shopifyRefundExternalId,
  shopifyShopScope,
  syncShopifyOrders,
} from '../lib/order-sync'
import type { ShopifyConnection, ShopifyOrder, ShopifyRefund } from '../types'

beforeAll(() => {
  vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

function makeConnection(overrides: Partial<ShopifyConnection> = {}): ShopifyConnection {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    shop_domain: 'minbutik.myshopify.com',
    shop_name: 'Testbutiken',
    client_id_encrypted: encryptCredential('client-id'),
    client_secret_encrypted: encryptCredential('client-secret'),
    status: 'active',
    currency: 'SEK',
    transaction_sync_enabled: true,
    last_order_synced_at: null,
    order_sync_priority_at: '1970-01-01T00:00:00.000Z',
    order_sync_claim_token: '11111111-1111-4111-8111-111111111111',
    order_sync_claimed_until: '2099-01-01T00:00:00.000Z',
    order_sync_scan_min_updated_at: null,
    order_sync_scan_min_inclusive: true,
    order_sync_scan_max_updated_at: null,
    order_sync_scan_cohort_updated_at: null,
    order_sync_scan_after: null,
    order_sync_scan_pass_found_new: false,
    error_message: null,
    connected_at: '2026-07-01T00:00:00.000Z',
    disconnected_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function money(amount: string, currencyCode = 'SEK') {
  return { shopMoney: { amount, currencyCode } }
}

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    legacyResourceId: '1042',
    name: '#1042',
    test: false,
    processedAt: '2026-08-01T09:04:30Z',
    updatedAt: '2026-08-01T09:05:00Z',
    displayFinancialStatus: 'PAID',
    paymentGatewayNames: ['Klarna'],
    totalPriceSet: money('1250.00'),
    refunds: [],
    ...overrides,
  }
}

/** One-page result helper; the loop terminates on hasNextPage: false. */
function page(orders: ShopifyOrder[], hasNextPage = false, endCursor: string | null = null) {
  return { orders, hasNextPage, endCursor }
}

function mockShopifyProvider(orders: ShopifyOrder[], pageSize = 50): void {
  listOrdersPage.mockImplementation(
    async (_session: unknown, options: {
      updatedAtMin: string
      updatedAtMinInclusive?: boolean
      updatedAtMax?: string
      after: string | null
    }) => {
      const minMs = Date.parse(options.updatedAtMin)
      const maxMs = options.updatedAtMax ? Date.parse(options.updatedAtMax) : Infinity
      const filtered = orders
        .filter(order => {
          const updatedMs = Date.parse(order.updatedAt)
          const aboveMin = options.updatedAtMinInclusive === false
            ? updatedMs > minMs
            : updatedMs >= minMs
          return aboveMin && updatedMs <= maxMs
        })
        .sort((left, right) =>
          Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
          || left.legacyResourceId.localeCompare(right.legacyResourceId),
        )
      const start = options.after ? Number(options.after.slice('offset:'.length)) : 0
      const nodes = filtered.slice(start, start + pageSize)
      const next = start + nodes.length
      return page(
        nodes,
        next < filtered.length,
        next < filtered.length ? `offset:${next}` : null,
      )
    },
  )
}

interface ShopifyPersistedState {
  lastOrderSyncedAt: string | null
  scanMinUpdatedAt: string | null
  scanMinInclusive: boolean
  scanMaxUpdatedAt: string | null
  scanCohortUpdatedAt: string | null
  scanAfter: string | null
  scanPassFoundNew: boolean
  seen: Set<string>
  status: ShopifyConnection['status']
  activeClaimToken: string | null
  claimGeneration: number
}

function makePersistedState(): ShopifyPersistedState {
  return {
    lastOrderSyncedAt: null,
    scanMinUpdatedAt: null,
    scanMinInclusive: true,
    scanMaxUpdatedAt: null,
    scanCohortUpdatedAt: null,
    scanAfter: null,
    scanPassFoundNew: false,
    seen: new Set(),
    status: 'active',
    activeClaimToken: '11111111-1111-4111-8111-111111111111',
    claimGeneration: 0,
  }
}

function connectionFromState(state: ShopifyPersistedState): ShopifyConnection {
  state.claimGeneration += 1
  state.activeClaimToken = `00000000-0000-4000-8000-${String(state.claimGeneration).padStart(12, '0')}`
  return makeConnection({
    last_order_synced_at: state.lastOrderSyncedAt,
    order_sync_scan_min_updated_at: state.scanMinUpdatedAt,
    order_sync_scan_min_inclusive: state.scanMinInclusive,
    order_sync_scan_max_updated_at: state.scanMaxUpdatedAt,
    order_sync_scan_cohort_updated_at: state.scanCohortUpdatedAt,
    order_sync_scan_after: state.scanAfter,
    order_sync_scan_pass_found_new: state.scanPassFoundNew,
    status: state.status,
    order_sync_claim_token: state.activeClaimToken,
  })
}

function canonicalTimestamp(value: string | null): string | null {
  return value === null ? null : new Date(Date.parse(value)).toISOString()
}

function restartShopifyState(state: ShopifyPersistedState): ShopifyPersistedState {
  const serialized = JSON.stringify({ ...state, seen: [...state.seen] })
  const parsed = JSON.parse(serialized) as Omit<ShopifyPersistedState, 'seen'> & { seen: string[] }
  const dbTimestamp = (value: string | null) => value?.replace(/Z$/, '+00:00') ?? null
  return {
    ...parsed,
    lastOrderSyncedAt: dbTimestamp(parsed.lastOrderSyncedAt),
    scanMinUpdatedAt: dbTimestamp(parsed.scanMinUpdatedAt),
    scanMaxUpdatedAt: dbTimestamp(parsed.scanMaxUpdatedAt),
    scanCohortUpdatedAt: dbTimestamp(parsed.scanCohortUpdatedAt),
    activeClaimToken: null,
    seen: new Set(parsed.seen),
  }
}

/** Minimal shared-state Supabase fake covering the production sync queries. */
function makeSupabaseMock(options: {
  lockThrough?: string | null
  lockError?: { message: string } | null
  updateError?: { message: string } | null
  updateMatched?: boolean
  state?: ShopifyPersistedState
  markerLimit?: number
  rpcErrorName?: string
  onCheckpoint?: () => void
} = {}) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const state = options.state ?? makePersistedState()
  const client = {
    from(table: string) {
      const filters = new Map<string, unknown>()
      let selectedIds: string[] = []
      const builder = {
        error: options.updateError ?? null,
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return builder
        },
        gt: () => builder,
        in: (_column: string, values: string[]) => {
          selectedIds = values
          return builder
        },
        maybeSingle: async () => ({
          data:
            table === 'company_settings'
              ? { bookkeeping_locked_through: options.lockThrough ?? null }
              : options.updateMatched === false || state.status !== 'active'
                ? null
                : filters.get('order_sync_claim_token') !== undefined
                    && filters.get('order_sync_claim_token') !== state.activeClaimToken
                  ? null
                  : { id: 'conn-1' },
          error:
            table === 'company_settings'
              ? options.lockError ?? null
              : options.updateError ?? null,
        }),
        update: (values: Record<string, unknown>) => {
          updates.push({ table, values })
          return builder
        },
        then: (resolve: (value: { data: unknown[]; error: null }) => void) => {
          if (table !== 'shopify_order_sync_seen') {
            resolve({ data: [], error: null })
            return
          }
          const updatedAt = canonicalTimestamp(String(filters.get('updated_at')))
          resolve({
            data: selectedIds
              .filter(orderId => state.seen.has(`${updatedAt}|${orderId}`))
              .map(order_id => ({ order_id })),
            error: null,
          })
        },
      }
      return builder
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === options.rpcErrorName) {
        return { data: null, error: { message: `${name} unavailable` } }
      }
      if (options.updateError) return { data: null, error: options.updateError }
      if (options.updateMatched === false) {
        return { data: false, error: null }
      }
      if (
        args.p_claim_token !== undefined
        && (state.status !== 'active' || args.p_claim_token !== state.activeClaimToken)
      ) {
        return { data: false, error: null }
      }
      if (name === 'checkpoint_shopify_order_sync') {
        const previousCohort = state.scanCohortUpdatedAt
        const nextCohort = canonicalTimestamp(args.p_cohort_updated_at as string | null)
        if (canonicalTimestamp(previousCohort) !== nextCohort) state.seen.clear()
        const completedOrderIds = args.p_completed_order_ids as string[]
        if (state.seen.size + completedOrderIds.length > (options.markerLimit ?? 100_000)) {
          return {
            data: null,
            error: { message: 'commerce order sync marker limit exceeded' },
          }
        }
        state.scanMinUpdatedAt = canonicalTimestamp(args.p_scan_min_updated_at as string)
        state.scanMinInclusive = args.p_scan_min_inclusive as boolean
        state.scanMaxUpdatedAt = canonicalTimestamp(args.p_scan_max_updated_at as string)
        state.scanCohortUpdatedAt = nextCohort
        state.scanAfter = args.p_after as string | null
        state.scanPassFoundNew = args.p_pass_found_new as boolean
        for (const id of completedOrderIds) {
          state.seen.add(`${nextCohort}|${id}`)
        }
        updates.push({
          table: 'shopify_connections',
          values: {
            order_sync_scan_min_updated_at: state.scanMinUpdatedAt,
            order_sync_scan_min_inclusive: state.scanMinInclusive,
            order_sync_scan_max_updated_at: state.scanMaxUpdatedAt,
            order_sync_scan_cohort_updated_at: state.scanCohortUpdatedAt,
            order_sync_scan_after: state.scanAfter,
            order_sync_scan_pass_found_new: state.scanPassFoundNew,
          },
        })
        options.onCheckpoint?.()
      } else if (name === 'complete_shopify_order_sync_cohort') {
        const cohort = canonicalTimestamp(args.p_cohort_updated_at as string)!
        if (canonicalTimestamp(state.scanCohortUpdatedAt) !== cohort) {
          return { data: false, error: null }
        }
        state.scanMinUpdatedAt = cohort
        state.scanMinInclusive = false
        state.scanCohortUpdatedAt = null
        state.scanAfter = null
        state.scanPassFoundNew = false
        state.seen.clear()
      } else if (name === 'complete_shopify_order_sync') {
        state.lastOrderSyncedAt = args.p_scan_max_updated_at as string
        state.scanMinUpdatedAt = null
        state.scanMinInclusive = true
        state.scanMaxUpdatedAt = null
        state.scanCohortUpdatedAt = null
        state.scanAfter = null
        state.scanPassFoundNew = false
        state.seen.clear()
        updates.push({
          table: 'shopify_connections',
          values: { last_order_synced_at: state.lastOrderSyncedAt, error_message: null },
        })
      } else if (name === 'revoke_commerce_connection_for_sync') {
        updates.push({
          table: 'shopify_connections',
          values: {
            status: 'revoked',
            client_id_encrypted: null,
            client_secret_encrypted: null,
          },
        })
        state.status = 'revoked'
        state.activeClaimToken = null
        state.seen.clear()
      }
      return { data: true, error: null }
    },
  }
  return { client: client as unknown as SupabaseClient, updates, state }
}

function cursorUpdates(updates: Array<{ table: string; values: Record<string, unknown> }>) {
  return updates.filter(
    (u) => u.table === 'shopify_connections' && 'last_order_synced_at' in u.values,
  )
}

function installPersistentIngest(existingExternalIds: Set<string> = new Set()): Set<string> {
  vi.mocked(ingestTransactions).mockImplementation(async (_client, _companyId, _userId, rows) => {
    let imported = 0
    let duplicates = 0
    for (const row of rows) {
      if (existingExternalIds.has(row.external_id)) {
        duplicates += 1
      } else {
        existingExternalIds.add(row.external_id)
        imported += 1
      }
    }
    return { imported, duplicates, errors: 0 } as Awaited<ReturnType<typeof ingestTransactions>>
  })
  return existingExternalIds
}

beforeEach(() => {
  vi.clearAllMocks()
  createShopifySession.mockReset().mockResolvedValue({
    shopDomain: 'minbutik.myshopify.com',
    accessToken: 'token-1',
  })
  listOrdersPage.mockReset().mockResolvedValue(page([]))
  vi.mocked(ingestTransactions).mockResolvedValue({
    imported: 0,
    duplicates: 0,
    errors: 0,
  } as Awaited<ReturnType<typeof ingestTransactions>>)
})

describe('frozen external_id formats', () => {
  // ⚠️ These assert the exact persisted formats. If this test fails, you are
  // about to orphan every previously imported Shopify row: do not update the
  // expectation without a coordinated backfill (see order-sync.ts).
  it('order id format is frozen', () => {
    expect(shopifyOrderExternalId('minbutik.myshopify.com', '1042')).toBe(
      'shopify_minbutik.myshopify.com_order_1042',
    )
  })

  it('refund id format is frozen', () => {
    expect(shopifyRefundExternalId('minbutik.myshopify.com', '77')).toBe(
      'shopify_minbutik.myshopify.com_refund_77',
    )
  })

  it('shop scope is the stored shop domain', () => {
    expect(shopifyShopScope('minbutik.myshopify.com')).toBe('minbutik.myshopify.com')
  })

  it('import source and ledger account are frozen', () => {
    expect(SHOPIFY_IMPORT_SOURCE).toBe('shopify')
    expect(SHOPIFY_LEDGER_ACCOUNT).toBe('1584')
  })
})

describe('orderQualifies', () => {
  it('requires a paid financial status and excludes test orders', () => {
    expect(orderQualifies(makeOrder())).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PARTIALLY_REFUNDED' }))).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'REFUNDED' }))).toBe(true)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PENDING' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'AUTHORIZED' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: 'PARTIALLY_PAID' }))).toBe(false)
    expect(orderQualifies(makeOrder({ displayFinancialStatus: null }))).toBe(false)
    expect(orderQualifies(makeOrder({ test: true }))).toBe(false)
  })
})

describe('mapOrder', () => {
  it('maps a paid order to one gross row dated by processedAt', () => {
    const rows = mapOrder('minbutik.myshopify.com', makeOrder())
    expect(rows).toEqual([
      {
        date: '2026-08-01',
        description: 'Shopify-order #1042',
        amount: 1250,
        currency: 'SEK',
        external_id: 'shopify_minbutik.myshopify.com_order_1042',
        import_source: 'shopify',
        reference: 'Klarna',
      },
    ])
  })

  it('rounds string money to two decimals and uppercases the currency', () => {
    const rows = mapOrder('s', makeOrder({ totalPriceSet: money('99.995', 'eur') }))
    expect(rows[0].amount).toBe(100)
    expect(rows[0].currency).toBe('EUR')
  })

  it('skips unpaid, test, zero-total and unparseable orders', () => {
    expect(mapOrder('s', makeOrder({ displayFinancialStatus: 'PENDING' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ test: true }))).toEqual([])
    expect(mapOrder('s', makeOrder({ totalPriceSet: money('0.00') }))).toEqual([])
    expect(mapOrder('s', makeOrder({ totalPriceSet: money('not-a-number') }))).toEqual([])
  })

  it('leaves the reference null when no gateways are reported', () => {
    expect(mapOrder('s', makeOrder({ paymentGatewayNames: [] }))[0].reference).toBeNull()
  })
})

describe('mapRefund', () => {
  const refund: ShopifyRefund = {
    legacyResourceId: '77',
    createdAt: '2026-08-03T10:00:00Z',
    totalRefundedSet: money('250.00'),
  }

  it('maps a refund to one negative row dated by the refund date', () => {
    const rows = mapRefund('minbutik.myshopify.com', makeOrder(), refund)
    expect(rows).toEqual([
      {
        date: '2026-08-03',
        description: 'Shopify-återbetalning order #1042',
        amount: -250,
        currency: 'SEK',
        external_id: 'shopify_minbutik.myshopify.com_refund_77',
        import_source: 'shopify',
        reference: null,
      },
    ])
  })

  it('skips zero-amount refunds', () => {
    expect(
      mapRefund('s', makeOrder(), { ...refund, totalRefundedSet: money('0') }),
    ).toEqual([])
  })
})

describe('rowBehindLock', () => {
  it('drops dates on/before the lock and keeps later ones', () => {
    expect(rowBehindLock('2026-06-30', '2026-06-30')).toBe(true)
    expect(rowBehindLock('2026-06-15', '2026-06-30')).toBe(true)
    expect(rowBehindLock('2026-07-01', '2026-06-30')).toBe(false)
    expect(rowBehindLock('2026-06-15', null)).toBe(false)
  })
})

describe('syncShopifyOrders', () => {
  it('ingests order and refund rows against the 1584 cash account and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          legacyResourceId: '77',
          createdAt: '2026-08-03T10:00:00Z',
          totalRefundedSet: money('250.00'),
        },
      ],
    })
    mockShopifyProvider([order])
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 2,
      duplicates: 0,
      errors: 0,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 2, refundsFetched: 1, imported: 2, duplicates: 0 })
    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1584',
      'SEK',
      'Shopify-saldo',
    )
    expect(ingestTransactions).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows, ingestOptions] =
      vi.mocked(ingestTransactions).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'shopify_minbutik.myshopify.com_order_1042',
      'shopify_minbutik.myshopify.com_refund_77',
    ])
    expect(ingestOptions).toEqual({ settlementAccount: '1584', skipAutoCategorization: true })

    // The completed watermark advances only after the exact cohort has a
    // no-new verification pass and provider discovery is exhausted.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.error_message).toBeNull()
    const watermarkMs = Date.parse(cursors[0].values.last_order_synced_at as string)
    expect(Math.abs(watermarkMs - Date.now())).toBeLessThan(60_000)
    expect(listOrdersPage).toHaveBeenCalledTimes(4)
  })

  it('walks Relay cursors within one fixed window', async () => {
    const { client } = makeSupabaseMock()
    const first = makeOrder()
    const second = makeOrder({
      legacyResourceId: '1043',
      name: '#1043',
      updatedAt: first.updatedAt,
    })
    mockShopifyProvider([first, second], 1)

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.fetched).toBe(4)
    const exactCalls = listOrdersPage.mock.calls
      .map(call => call[1])
      .filter(options => options.updatedAtMin === options.updatedAtMax)
    expect(exactCalls.map(options => options.after)).toEqual([
      null,
      'offset:1',
      null,
      'offset:1',
    ])
    expect(new Set(exactCalls.map(options => JSON.stringify({
      min: options.updatedAtMin,
      max: options.updatedAtMax,
    }))).size).toBe(1)
  })

  it('crosses 10,000 covered overlap rows and reaches a newer row across fresh invocations', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-03T00:00:00.000Z'))
    const overlap = Array.from({ length: 10_000 }, (_, index) => makeOrder({
      legacyResourceId: String(index + 1),
      name: `#${index + 1}`,
      updatedAt: '2026-08-01T00:00:00.000Z',
    }))
    const newer = makeOrder({
      legacyResourceId: 'newer',
      name: '#newer',
      updatedAt: '2026-08-02T01:00:00.000Z',
    })
    mockShopifyProvider([...overlap, newer], 100)
    let persisted = makePersistedState()
    persisted.lastOrderSyncedAt = '2026-08-02T00:00:00.000Z'
    let transactionIds = new Set(overlap.map(order =>
      shopifyOrderExternalId('minbutik.myshopify.com', order.legacyResourceId),
    ))

    try {
      for (let invocation = 0; invocation < 6; invocation++) {
        installPersistentIngest(transactionIds)
        await syncShopifyOrders(
          makeSupabaseMock({ state: persisted }).client,
          connectionFromState(persisted),
        )
        if (persisted.scanMaxUpdatedAt === null
            && persisted.lastOrderSyncedAt === '2026-08-03T00:00:00.000Z') break
        persisted = restartShopifyState(persisted)
        transactionIds = new Set(JSON.parse(JSON.stringify([...transactionIds])) as string[])
      }

      expect(transactionIds).toContain('shopify_minbutik.myshopify.com_order_newer')
      expect(persisted.lastOrderSyncedAt).toBe('2026-08-03T00:00:00.000Z')
      expect(persisted.scanMaxUpdatedAt).toBeNull()
      expect(persisted.seen.size).toBe(0)
    } finally {
      now.mockRestore()
    }
  })

  it('finishes a 10,050-order equal-updatedAt cohort across capped fresh invocations', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-03T00:00:00.000Z'))
    const cohort = Array.from({ length: 10_050 }, (_, index) => makeOrder({
      legacyResourceId: String(index + 1),
      name: `#${index + 1}`,
      updatedAt: '2026-08-01T09:05:00.000Z',
    }))
    mockShopifyProvider(cohort, 100)
    let persisted = makePersistedState()
    let transactionIds = new Set<string>()

    try {
      for (let invocation = 0; invocation < 6; invocation++) {
        installPersistentIngest(transactionIds)
        await syncShopifyOrders(
          makeSupabaseMock({ state: persisted }).client,
          connectionFromState(persisted),
        )
        if (persisted.scanMaxUpdatedAt === null && persisted.lastOrderSyncedAt !== null) break
        persisted = restartShopifyState(persisted)
        transactionIds = new Set(JSON.parse(JSON.stringify([...transactionIds])) as string[])
      }

      expect(transactionIds.size).toBe(10_050)
      expect(persisted.lastOrderSyncedAt).toBe('2026-08-03T00:00:00.000Z')
      expect(persisted.scanMaxUpdatedAt).toBeNull()
      expect(persisted.seen.size).toBe(0)
    } finally {
      now.mockRestore()
    }
  })

  it('persists exact-cohort continuation across repeated deadline-limited invocations', async () => {
    const baseMs = Date.parse('2026-08-03T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(baseMs)
    const cohort = Array.from({ length: 250 }, (_, index) => makeOrder({
      legacyResourceId: String(index + 1),
      name: `#${index + 1}`,
      updatedAt: '2026-08-01T09:05:00.000Z',
    }))
    mockShopifyProvider(cohort, 50)
    const provider = listOrdersPage.getMockImplementation()!
    let persisted = makePersistedState()
    const continuations: Array<string | null> = []

    try {
      for (let invocation = 0; invocation < 3; invocation++) {
        vi.setSystemTime(baseMs)
        let exactCalls = 0
        listOrdersPage.mockImplementation(async (...args: unknown[]) => {
          const result = await provider(...args)
          const options = args[1] as { updatedAtMin: string; updatedAtMax?: string }
          if (options.updatedAtMin === options.updatedAtMax && ++exactCalls === 2) {
            vi.setSystemTime(baseMs + 10)
          }
          return result
        })
        const summary = await syncShopifyOrders(
          makeSupabaseMock({ state: persisted }).client,
          connectionFromState(persisted),
          undefined,
          baseMs + 10,
        )
        expect(summary.deadlineReached).toBe(true)
        continuations.push(persisted.scanAfter)
        persisted = restartShopifyState(persisted)
      }

      expect(continuations).toEqual(['offset:50', 'offset:100', 'offset:150'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts cleanly after list, ingest, and checkpoint failures', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-03T00:00:00.000Z'))
    const order = makeOrder({ updatedAt: '2026-08-01T09:05:00.000Z' })
    const persisted = makePersistedState()

    try {
      listOrdersPage.mockRejectedValueOnce(new Error('provider unavailable'))
      await expect(syncShopifyOrders(
        makeSupabaseMock({ state: persisted }).client,
        connectionFromState(persisted),
      )).rejects.toThrow('provider unavailable')
      expect(persisted.scanMaxUpdatedAt).toBe('2026-08-03T00:00:00.000Z')

      mockShopifyProvider([order], 1)
      vi.mocked(ingestTransactions).mockRejectedValueOnce(new Error('ingest unavailable'))
      await expect(syncShopifyOrders(
        makeSupabaseMock({ state: persisted }).client,
        connectionFromState(persisted),
      )).rejects.toThrow('did not reach a confirmed outcome')
      expect(persisted.seen.size).toBe(0)

      mockShopifyProvider([order], 1)
      await expect(syncShopifyOrders(
        makeSupabaseMock({ state: persisted, markerLimit: 0 }).client,
        connectionFromState(persisted),
      )).rejects.toThrow('marker limit exceeded')
      expect(persisted.lastOrderSyncedAt).toBeNull()

      mockShopifyProvider([order], 1)
      installPersistentIngest()
      await syncShopifyOrders(
        makeSupabaseMock({ state: persisted }).client,
        connectionFromState(persisted),
      )
      expect(persisted.lastOrderSyncedAt).toBe('2026-08-03T00:00:00.000Z')
    } finally {
      now.mockRestore()
    }
  })

  it('resets an invalid persisted exact-cohort cursor and replays safely', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-03T00:00:00.000Z'))
    const first = makeOrder({ legacyResourceId: '1', name: '#1' })
    const second = makeOrder({ legacyResourceId: '2', name: '#2' })
    const persisted = makePersistedState()
    persisted.scanMinUpdatedAt = first.updatedAt
    persisted.scanMaxUpdatedAt = '2026-08-03T00:00:00.000Z'
    persisted.scanCohortUpdatedAt = first.updatedAt
    persisted.scanAfter = 'invalid-cursor'
    persisted.scanPassFoundNew = true
    persisted.seen.add(`${canonicalTimestamp(first.updatedAt)}|${first.legacyResourceId}`)

    try {
      listOrdersPage.mockRejectedValueOnce(new Error('invalid cursor'))
      await expect(syncShopifyOrders(
        makeSupabaseMock({ state: persisted }).client,
        connectionFromState(persisted),
      )).rejects.toThrow('invalid cursor')
      expect(persisted.scanAfter).toBeNull()
      expect(persisted.seen).toContain(
        `${canonicalTimestamp(first.updatedAt)}|${first.legacyResourceId}`,
      )

      mockShopifyProvider([first, second], 1)
      const imported = installPersistentIngest(new Set([
        shopifyOrderExternalId('minbutik.myshopify.com', first.legacyResourceId),
      ]))
      await syncShopifyOrders(
        makeSupabaseMock({ state: persisted }).client,
        connectionFromState(persisted),
      )

      expect(imported).toContain(
        shopifyOrderExternalId('minbutik.myshopify.com', second.legacyResourceId),
      )
      expect(persisted.scanMaxUpdatedAt).toBeNull()
      expect(persisted.lastOrderSyncedAt).toBe('2026-08-03T00:00:00.000Z')
    } finally {
      now.mockRestore()
    }
  })

  it('resumes a PostgreSQL +00:00 cohort against provider Z timestamps', async () => {
    const order = makeOrder({ legacyResourceId: 'round-trip', name: '#round-trip' })
    let persisted = makePersistedState()
    persisted.scanMinUpdatedAt = '2026-08-01T09:05:00+00:00'
    persisted.scanMaxUpdatedAt = '2026-08-03T00:00:00+00:00'
    persisted.scanCohortUpdatedAt = '2026-08-01T09:05:00+00:00'
    persisted = restartShopifyState(persisted)
    mockShopifyProvider([order], 1)

    await syncShopifyOrders(
      makeSupabaseMock({ state: persisted }).client,
      connectionFromState(persisted),
    )

    const exactCalls = listOrdersPage.mock.calls
      .map(call => call[1])
      .filter(options => options.updatedAtMin === options.updatedAtMax)
    expect(exactCalls[0].updatedAtMin).toBe('2026-08-01T09:05:00.000Z')
    expect(persisted.scanMaxUpdatedAt).toBeNull()
    expect(persisted.lastOrderSyncedAt).toBe('2026-08-03T00:00:00.000Z')
  })

  it('re-polls with a 24h overlap from the persisted cursor', async () => {
    const { client } = makeSupabaseMock()
    await syncShopifyOrders(
      client,
      makeConnection({ last_order_synced_at: '2026-08-05T12:00:00.000Z' }),
    )
    expect(listOrdersPage.mock.calls[0][1].updatedAtMin).toBe('2026-08-04T12:00:00.000Z')
  })

  it('recovers a future cursor through the documented initial lookback', async () => {
    const runStartMs = Date.parse('2026-08-10T12:00:00.000Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(runStartMs)
    const { client, updates } = makeSupabaseMock()

    try {
      await syncShopifyOrders(
        client,
        makeConnection({ last_order_synced_at: '2026-08-20T12:00:00.000Z' }),
      )
      expect(listOrdersPage.mock.calls[0][1].updatedAtMin).toBe(
        '2026-05-12T12:00:00.000Z',
      )
      expect(cursorUpdates(updates).at(-1)?.values.last_order_synced_at).toBe(
        '2026-08-10T12:00:00.000Z',
      )
    } finally {
      now.mockRestore()
    }
  })

  it('drops rows dated on/before the bookkeeping lock on every run', async () => {
    const { client, updates } = makeSupabaseMock({ lockThrough: '2026-08-02' })
    // Order paid 2026-08-01 (behind lock), refund created 2026-08-03 (after).
    const order = makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [
        {
          legacyResourceId: '77',
          createdAt: '2026-08-03T10:00:00Z',
          totalRefundedSet: money('250.00'),
        },
      ],
    })
    mockShopifyProvider([order])

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.skippedLocked).toBe(1)
    const [, , , rows] = vi.mocked(ingestTransactions).mock.calls[0]
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'shopify_minbutik.myshopify.com_refund_77',
    ])
    // The completed watermark still advances: the drop is by design.
    expect(cursorUpdates(updates)).toHaveLength(1)
  })

  it('holds the cursor below a page whose ingest reported errors', async () => {
    const { client, updates } = makeSupabaseMock()
    // Two orders so the assertion distinguishes "first updatedAt minus 1s"
    // (the floor rule) from "max updatedAt minus 1s".
    mockShopifyProvider([
      makeOrder(),
      makeOrder({ legacyResourceId: '1043', name: '#1043', updatedAt: '2026-08-02T08:00:00Z' }),
    ])
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 0,
      duplicates: 0,
      errors: 1,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    expect(cursorUpdates(updates)).toHaveLength(0)
  })

  it('falls back to the first order currency when the shop currency was unreadable', async () => {
    const { client } = makeSupabaseMock()
    mockShopifyProvider([makeOrder({ totalPriceSet: money('10.00', 'eur') })])

    await syncShopifyOrders(client, makeConnection({ currency: null }))

    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1584',
      'EUR',
      'Shopify-saldo',
    )
  })

  it('surfaces a cash-account failure on the connection instead of failing silently', async () => {
    const { client, updates } = makeSupabaseMock()
    mockShopifyProvider([makeOrder()])
    vi.mocked(ensureManualCashAccount).mockRejectedValueOnce(
      new Error('cash account 1584 exists with currency EUR'),
    )

    await expect(syncShopifyOrders(client, makeConnection())).rejects.toThrow(
      /confirmed outcome/,
    )
    const errorUpdate = updates.find(
      (u) => u.table === 'shopify_connections' && 'error_message' in u.values,
    )
    expect(errorUpdate?.values.error_message).toMatch(/1584/)
  })

  it('keeps an unparseable order total incomplete without crossing it', async () => {
    const persisted = makePersistedState()
    const { client, updates } = makeSupabaseMock({ state: persisted })
    mockShopifyProvider([makeOrder({ totalPriceSet: money('not-a-number') })])

    await expect(syncShopifyOrders(client, connectionFromState(persisted))).rejects.toThrow(
      /malformed and remains pending/,
    )
    expect(ingestTransactions).not.toHaveBeenCalled()
    expect(cursorUpdates(updates)).toHaveLength(0)
    expect(persisted.scanMaxUpdatedAt).not.toBeNull()
    expect(persisted.seen.size).toBe(0)
  })

  it('keeps an unparseable refund incomplete without crossing its order', async () => {
    const persisted = makePersistedState()
    const { client, updates } = makeSupabaseMock({ state: persisted })
    mockShopifyProvider([makeOrder({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      refunds: [{
        legacyResourceId: 'bad-refund',
        createdAt: '2026-08-01T10:00:00Z',
        totalRefundedSet: money('invalid'),
      }],
    })])

    await expect(syncShopifyOrders(client, connectionFromState(persisted))).rejects.toThrow(
      /malformed and remains pending/,
    )
    expect(cursorUpdates(updates)).toHaveLength(0)
    expect(persisted.seen.size).toBe(0)
  })

  it('does not exchange a token when the initial checkpoint crosses the deadline', async () => {
    const baseMs = Date.parse('2026-08-03T00:00:00.000Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(baseMs)
    const persisted = makePersistedState()
    const db = makeSupabaseMock({
      state: persisted,
      onCheckpoint: () => now.mockReturnValue(baseMs + 10),
    })

    try {
      await expect(syncShopifyOrders(
        db.client,
        connectionFromState(persisted),
        undefined,
        baseMs + 10,
      )).rejects.toThrow(/confirmed outcome/)
      expect(createShopifySession).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('advances a watermark on an empty first run so quiet stores rotate in the cron', async () => {
    const { client, updates } = makeSupabaseMock()

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.fetched).toBe(0)
    // Without this, an empty store keeps a NULL cursor forever and the cron's
    // nullsFirst selection re-picks it every night ahead of everyone else.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    const watermarkMs = Date.parse(cursors[0].values.last_order_synced_at as string)
    expect(Math.abs(watermarkMs - Date.now())).toBeLessThan(60_000)
  })

  it('does nothing for a connection without credentials or not active', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncShopifyOrders(
      client,
      makeConnection({ client_id_encrypted: null }),
    )
    expect(summary.fetched).toBe(0)
    expect(createShopifySession).not.toHaveBeenCalled()

    const revokedSummary = await syncShopifyOrders(
      client,
      makeConnection({ status: 'revoked' }),
    )
    expect(revokedSummary.fetched).toBe(0)
  })

  it('flips the connection to revoked when the token exchange rejects the credentials', async () => {
    const { client, updates } = makeSupabaseMock()
    createShopifySession.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    const revokeUpdate = updates.find((u) => u.values.status === 'revoked')
    expect(revokeUpdate?.values.status).toBe('revoked')
    expect(revokeUpdate?.values.client_id_encrypted).toBeNull()
  })

  it('flips the connection to revoked when the store rejects the token mid-run', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncShopifyOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    expect(updates.find((u) => u.values.status === 'revoked')?.values.status).toBe(
      'revoked',
    )
  })

  it('fails instead of reporting revocation when the durable write fails', async () => {
    const { client } = makeSupabaseMock({
      rpcErrorName: 'revoke_commerce_connection_for_sync',
    })
    createShopifySession.mockRejectedValueOnce(new Error('REVOKED'))

    await expect(syncShopifyOrders(client, makeConnection())).rejects.toThrow(
      /Failed to persist Shopify credential revocation: revoke_commerce_connection_for_sync unavailable/,
    )
  })

  it('fails loudly when a page cursor update does not persist', async () => {
    const { client } = makeSupabaseMock({
      updateError: { message: 'cursor write unavailable' },
    })
    mockShopifyProvider([makeOrder()])

    await expect(syncShopifyOrders(client, makeConnection())).rejects.toThrow(
      /Failed to checkpoint Shopify order scan: cursor write unavailable/,
    )
  })

  it('fails loudly when a page cursor update matches no row', async () => {
    const { client } = makeSupabaseMock({ updateMatched: false })
    mockShopifyProvider([makeOrder()])

    await expect(syncShopifyOrders(client, makeConnection())).rejects.toThrow(
      /Failed to checkpoint Shopify order scan: exact active lease was not matched/,
    )
  })

  it('stops before fetching when the deadline is already reached', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncShopifyOrders(
      client,
      makeConnection(),
      undefined,
      Date.now() - 1,
    )
    expect(summary.deadlineReached).toBe(true)
    expect(createShopifySession).not.toHaveBeenCalled()
    expect(listOrdersPage).not.toHaveBeenCalled()
  })

  it('stops between pages on deadline with the processed pages cursored', async () => {
    const { client, updates } = makeSupabaseMock()
    const baseMs = Date.parse('2026-08-10T12:00:00.000Z')
    let nowMs = baseMs
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const deadlineMs = baseMs + 10
    listOrdersPage.mockImplementationOnce(async () => {
      nowMs = deadlineMs
      return page([makeOrder()], true, 'cursor-1')
    })

    try {
      const summary = await syncShopifyOrders(client, makeConnection(), undefined, deadlineMs)

      expect(summary.deadlineReached).toBe(true)
      // The discovery result is not processed after its await crosses deadline.
      expect(listOrdersPage).toHaveBeenCalledTimes(1)
      expect(cursorUpdates(updates)).toHaveLength(0)
    } finally {
      now.mockRestore()
    }
  })
})
