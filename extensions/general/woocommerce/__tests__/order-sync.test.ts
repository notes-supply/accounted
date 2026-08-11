import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const listOrdersPage = vi.fn()
const listOrderRefunds = vi.fn()

vi.mock('../lib/api-client', () => ({
  listOrdersPage: (...args: unknown[]) => listOrdersPage(...args),
  listOrderRefunds: (...args: unknown[]) => listOrderRefunds(...args),
  isRevokedCredentialsError: (error: unknown) =>
    error instanceof Error && error.message.startsWith('REVOKED'),
  WooCommerceDeadlineError: class WooCommerceDeadlineError extends Error {},
  WC_PAGE_SIZE: 100,
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
  WOOCOMMERCE_IMPORT_SOURCE,
  WOOCOMMERCE_LEDGER_ACCOUNT,
  mapOrder,
  mapRefund,
  orderQualifies,
  rowBehindLock,
  syncWooCommerceOrders,
  wooOrderExternalId,
  wooRefundExternalId,
  wooStoreScope,
} from '../lib/order-sync'
import type { WooCommerceConnection, WooOrder, WooRefund } from '../types'

process.env.WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY = 'test-key'

function makeConnection(overrides: Partial<WooCommerceConnection> = {}): WooCommerceConnection {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    store_url: 'https://shop.example.se',
    store_name: 'Testbutiken',
    consumer_key_encrypted: encryptCredential('ck_test'),
    consumer_secret_encrypted: encryptCredential('cs_test'),
    key_permissions: 'read',
    status: 'active',
    oauth_state: null,
    currency: 'SEK',
    prices_include_tax: true,
    wc_version: '9.9.5',
    transaction_sync_enabled: true,
    last_order_synced_at: null,
    order_sync_priority_at: '1970-01-01T00:00:00.000Z',
    order_sync_claim_token: '22222222-2222-4222-8222-222222222222',
    order_sync_claimed_until: '2099-01-01T00:00:00.000Z',
    order_sync_scan_modified_after: null,
    order_sync_cohort_modified_at: null,
    order_sync_cohort_page: 1,
    order_sync_cohort_pass_found_new: false,
    order_sync_cohort_expected_total: null,
    order_sync_cohort_expected_pages: null,
    order_sync_cohort_pass_seen_count: 0,
    order_sync_cohort_pass_last_order_id: null,
    error_message: null,
    connected_at: '2026-07-01T00:00:00.000Z',
    disconnected_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeOrder(overrides: Partial<WooOrder> = {}): WooOrder {
  return {
    id: 1042,
    number: '1042',
    status: 'processing',
    currency: 'sek',
    total: '1250.00',
    total_tax: '250.00',
    prices_include_tax: true,
    date_created_gmt: '2026-08-01T09:00:00',
    date_modified_gmt: '2026-08-01T09:05:00',
    date_paid_gmt: '2026-08-01T09:04:30',
    payment_method: 'stripe',
    payment_method_title: 'Kortbetalning',
    transaction_id: 'pi_abc123',
    refunds: [],
    ...overrides,
  }
}

interface WooPersistedState {
  last_order_synced_at: string | null
  order_sync_scan_modified_after: string | null
  order_sync_cohort_modified_at: string | null
  order_sync_cohort_page: number
  order_sync_cohort_pass_found_new: boolean
  order_sync_cohort_expected_total: number | null
  order_sync_cohort_expected_pages: number | null
  order_sync_cohort_pass_seen_count: number
  order_sync_cohort_pass_last_order_id: number | null
  status: WooCommerceConnection['status']
  activeClaimToken: string | null
  claimGeneration: number
  seen: Set<string>
}

function makeWooPersistedState(): WooPersistedState {
  return {
    last_order_synced_at: null,
    order_sync_scan_modified_after: null,
    order_sync_cohort_modified_at: null,
    order_sync_cohort_page: 1,
    order_sync_cohort_pass_found_new: false,
    order_sync_cohort_expected_total: null,
    order_sync_cohort_expected_pages: null,
    order_sync_cohort_pass_seen_count: 0,
    order_sync_cohort_pass_last_order_id: null,
    status: 'active',
    activeClaimToken: '22222222-2222-4222-8222-222222222222',
    claimGeneration: 0,
    seen: new Set(),
  }
}

function wooConnectionFromState(state: WooPersistedState): WooCommerceConnection {
  state.claimGeneration += 1
  state.activeClaimToken = `00000000-0000-4000-8000-${String(state.claimGeneration).padStart(12, '0')}`
  return makeConnection({
    last_order_synced_at: state.last_order_synced_at,
    order_sync_scan_modified_after: state.order_sync_scan_modified_after,
    order_sync_cohort_modified_at: state.order_sync_cohort_modified_at,
    order_sync_cohort_page: state.order_sync_cohort_page,
    order_sync_cohort_pass_found_new: state.order_sync_cohort_pass_found_new,
    order_sync_cohort_expected_total: state.order_sync_cohort_expected_total,
    order_sync_cohort_expected_pages: state.order_sync_cohort_expected_pages,
    order_sync_cohort_pass_seen_count: state.order_sync_cohort_pass_seen_count,
    order_sync_cohort_pass_last_order_id: state.order_sync_cohort_pass_last_order_id,
    status: state.status,
    order_sync_claim_token: state.activeClaimToken,
  })
}

function restartWooState(state: WooPersistedState): WooPersistedState {
  const serialized = JSON.stringify({ ...state, seen: [...state.seen] })
  const parsed = JSON.parse(serialized) as Omit<WooPersistedState, 'seen'> & { seen: string[] }
  const dbTimestamp = (value: string | null) => value?.replace(/Z$/, '+00:00') ?? null
  return {
    ...parsed,
    last_order_synced_at: dbTimestamp(parsed.last_order_synced_at),
    order_sync_scan_modified_after: dbTimestamp(parsed.order_sync_scan_modified_after),
    order_sync_cohort_modified_at: dbTimestamp(parsed.order_sync_cohort_modified_at),
    activeClaimToken: null,
    seen: new Set(parsed.seen),
  }
}

/** Minimal chainable supabase mock covering the sync's query patterns. */
function makeSupabaseMock(options: {
  lockThrough?: string | null
  lockError?: { message: string } | null
  updateError?: { message: string } | null
  updateMatched?: boolean
  seen?: Set<string>
  state?: WooPersistedState
  markerLimit?: number
  onCompleteCohort?: () => void
} = {}) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = []
  const state = options.state ?? makeWooPersistedState()
  const seen = options.seen ?? state.seen
  const client = {
    from(table: string) {
      let operation: 'select' | 'update' | 'delete' | null = null
      let updateValues: Record<string, unknown> | null = null
      const filters = new Map<string, unknown>()
      const builder = {
        select: () => {
          if (operation === null) operation = 'select'
          return builder
        },
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return builder
        },
        gt: () => builder,
        in: async (_column: string, values: number[]) => ({
          data: values
            .filter(orderId =>
              seen.has(`${filters.get('connection_id')}:${filters.get('modified_at')}:${orderId}`),
            )
            .map(order_id => ({ order_id })),
          error: null,
        }),
        maybeSingle: async () => {
          const tokenMatched = filters.get('order_sync_claim_token') === undefined
            || filters.get('order_sync_claim_token') === state.activeClaimToken
          const matched = options.updateMatched !== false
            && state.status === 'active'
            && tokenMatched
          if (operation === 'update' && matched && updateValues) {
            Object.assign(state, updateValues)
          }
          return {
            data:
              table === 'company_settings'
                ? { bookkeeping_locked_through: options.lockThrough ?? null }
                : operation === 'update'
                  ? matched ? { id: 'conn-1' } : null
                  : table === 'woocommerce_connections' && matched
                    ? { id: 'conn-1' }
                    : null,
            error:
              table === 'company_settings'
                ? options.lockError ?? null
                : operation === 'update'
                  ? options.updateError ?? null
                  : null,
          }
        },
        update: (values: Record<string, unknown>) => {
          operation = 'update'
          updateValues = values
          updates.push({ table, values })
          return builder
        },
        upsert: async (
          values: Array<{ connection_id: string; modified_at: string; order_id: number }>,
        ) => {
          for (const value of values) {
            seen.add(`${value.connection_id}:${value.modified_at}:${value.order_id}`)
          }
          return { error: null }
        },
        delete: () => {
          operation = 'delete'
          return builder
        },
        then: (
          resolve: (value: { data: unknown; error: { message: string } | null }) => void,
        ) => {
          if (operation === 'delete') {
            const prefix = `${filters.get('connection_id')}:${filters.get('modified_at')}:`
            for (const key of seen) if (key.startsWith(prefix)) seen.delete(key)
          }
          resolve({
            data: updateValues,
            error: operation === 'update' ? options.updateError ?? null : null,
          })
        },
      }
      return builder
    },
    async rpc(name: string, args: Record<string, unknown>) {
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
      const connectionId = String(args.p_connection_id)
      const modifiedAt = String(args.p_modified_at)
      if (name === 'record_woocommerce_order_sync_seen') {
        if (seen.size + (args.p_order_ids as number[]).length > (options.markerLimit ?? 100_000)) {
          return { data: null, error: { message: 'commerce order sync marker limit exceeded' } }
        }
        for (const orderId of args.p_order_ids as number[]) {
          seen.add(`${connectionId}:${modifiedAt}:${orderId}`)
        }
      } else if (name === 'start_woocommerce_order_sync_cohort') {
        for (const key of seen) {
          if (key.startsWith(`${connectionId}:`) && !key.startsWith(`${connectionId}:${modifiedAt}:`)) {
            seen.delete(key)
          }
        }
        for (const orderId of args.p_order_ids as number[]) {
          seen.add(`${connectionId}:${modifiedAt}:${orderId}`)
        }
        state.last_order_synced_at = args.p_last_order_synced_at as string | null
          ?? state.last_order_synced_at
        state.order_sync_scan_modified_after = String(args.p_scan_modified_after)
        state.order_sync_cohort_modified_at = modifiedAt
        state.order_sync_cohort_page = 1
        state.order_sync_cohort_pass_found_new = false
        state.order_sync_cohort_expected_total = null
        state.order_sync_cohort_expected_pages = null
        state.order_sync_cohort_pass_seen_count = 0
        state.order_sync_cohort_pass_last_order_id = null
        updates.push({
          table: 'woocommerce_connections',
          values: {
            last_order_synced_at: args.p_last_order_synced_at,
            order_sync_scan_modified_after: args.p_scan_modified_after,
            order_sync_cohort_modified_at: modifiedAt,
            order_sync_cohort_page: 1,
            order_sync_cohort_pass_found_new: false,
            error_message: null,
          },
        })
      } else if (name === 'checkpoint_woocommerce_order_sync') {
        if (
          state.order_sync_cohort_modified_at === null
          || Date.parse(state.order_sync_cohort_modified_at) !== Date.parse(modifiedAt)
        ) {
          return { data: false, error: null }
        }
        const completedOrderIds = args.p_completed_order_ids as number[]
        if (seen.size + completedOrderIds.length > (options.markerLimit ?? 100_000)) {
          return { data: null, error: { message: 'commerce order sync marker limit exceeded' } }
        }
        for (const orderId of completedOrderIds) {
          seen.add(`${connectionId}:${modifiedAt}:${orderId}`)
        }
        state.order_sync_scan_modified_after = String(args.p_scan_modified_after)
        state.order_sync_cohort_page = Number(args.p_page)
        state.order_sync_cohort_pass_found_new = Boolean(args.p_pass_found_new)
        state.order_sync_cohort_expected_total = args.p_expected_total as number | null
        state.order_sync_cohort_expected_pages = args.p_expected_pages as number | null
        state.order_sync_cohort_pass_seen_count = Number(args.p_pass_seen_count)
        state.order_sync_cohort_pass_last_order_id = args.p_pass_last_order_id as number | null
        updates.push({
          table: 'woocommerce_connections',
          values: {
            order_sync_scan_modified_after: args.p_scan_modified_after,
            order_sync_cohort_page: args.p_page,
            order_sync_cohort_pass_found_new: args.p_pass_found_new,
            order_sync_cohort_expected_total: args.p_expected_total,
            order_sync_cohort_expected_pages: args.p_expected_pages,
            order_sync_cohort_pass_seen_count: args.p_pass_seen_count,
            order_sync_cohort_pass_last_order_id: args.p_pass_last_order_id,
          },
        })
      } else if (name === 'complete_woocommerce_order_sync_cohort') {
        if (
          state.order_sync_cohort_modified_at === null
          || Date.parse(state.order_sync_cohort_modified_at) !== Date.parse(modifiedAt)
        ) {
          return { data: false, error: null }
        }
        const prefix = `${connectionId}:${modifiedAt}:`
        for (const key of seen) if (key.startsWith(prefix)) seen.delete(key)
        state.last_order_synced_at = args.p_last_order_synced_at as string | null
          ?? state.last_order_synced_at
        state.order_sync_scan_modified_after = modifiedAt
        state.order_sync_cohort_modified_at = null
        state.order_sync_cohort_page = 1
        state.order_sync_cohort_pass_found_new = false
        state.order_sync_cohort_expected_total = null
        state.order_sync_cohort_expected_pages = null
        state.order_sync_cohort_pass_seen_count = 0
        state.order_sync_cohort_pass_last_order_id = null
        updates.push({
          table: 'woocommerce_connections',
          values: {
            last_order_synced_at: args.p_last_order_synced_at,
            order_sync_scan_modified_after: modifiedAt,
            order_sync_cohort_modified_at: null,
            order_sync_cohort_page: 1,
            order_sync_cohort_pass_found_new: false,
            error_message: null,
          },
        })
        options.onCompleteCohort?.()
      } else if (name === 'complete_woocommerce_order_sync') {
        state.last_order_synced_at = String(args.p_last_order_synced_at)
        state.order_sync_scan_modified_after = null
        state.order_sync_cohort_modified_at = null
        updates.push({
          table: 'woocommerce_connections',
          values: {
            last_order_synced_at: args.p_last_order_synced_at,
            order_sync_scan_modified_after: null,
            error_message: null,
          },
        })
      } else if (name === 'revoke_commerce_connection_for_sync') {
        updates.push({
          table: 'woocommerce_connections',
          values: {
            status: 'revoked',
            consumer_key_encrypted: null,
            consumer_secret_encrypted: null,
          },
        })
        state.status = 'revoked'
        state.activeClaimToken = null
        state.last_order_synced_at = null
        state.order_sync_scan_modified_after = null
        state.order_sync_cohort_modified_at = null
        state.order_sync_cohort_page = 1
        state.order_sync_cohort_pass_found_new = false
        for (const key of seen) if (key.startsWith(`${connectionId}:`)) seen.delete(key)
      }
      return { data: true, error: null }
    },
  }
  return { client: client as unknown as SupabaseClient, updates, seen }
}

function cursorUpdates(updates: Array<{ table: string; values: Record<string, unknown> }>) {
  return updates.filter(
    (u) => u.table === 'woocommerce_connections' && 'last_order_synced_at' in u.values,
  )
}

function wooPage<T>(
  items: T[],
  total = items.length,
  totalPages = total === 0 ? 0 : 1,
  page = 1,
) {
  return { items, total, totalPages, page }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Termination is an empty page; every test starts from a quiet store and
  // enqueues its pages with mockResolvedValueOnce.
  listOrdersPage.mockReset().mockResolvedValue(wooPage([]))
  listOrderRefunds.mockReset().mockResolvedValue([])
  vi.mocked(ingestTransactions).mockResolvedValue({
    imported: 0,
    duplicates: 0,
    errors: 0,
  } as Awaited<ReturnType<typeof ingestTransactions>>)
})

describe('frozen external_id formats', () => {
  // ⚠️ These assert the exact persisted formats. If this test fails, you are
  // about to orphan every previously imported WooCommerce row: do not update
  // the expectation without a coordinated backfill (see order-sync.ts).
  it('order id format is frozen', () => {
    expect(wooOrderExternalId('shop.example.se', 1042)).toBe(
      'woo_shop.example.se_order_1042',
    )
  })

  it('refund id format is frozen', () => {
    expect(wooRefundExternalId('shop.example.se', 77)).toBe(
      'woo_shop.example.se_refund_77',
    )
  })

  it('store scope strips exactly the https prefix and keeps host + path', () => {
    expect(wooStoreScope('https://shop.example.se')).toBe('shop.example.se')
    expect(wooStoreScope('https://example.se/butik')).toBe('example.se/butik')
  })

  it('import source and ledger account are frozen', () => {
    expect(WOOCOMMERCE_IMPORT_SOURCE).toBe('woocommerce')
    expect(WOOCOMMERCE_LEDGER_ACCOUNT).toBe('1680')
  })
})

describe('orderQualifies', () => {
  it('requires date_paid and excludes trashed orders', () => {
    expect(orderQualifies(makeOrder())).toBe(true)
    expect(orderQualifies(makeOrder({ status: 'refunded' }))).toBe(true)
    expect(orderQualifies(makeOrder({ date_paid_gmt: null }))).toBe(false)
    expect(orderQualifies(makeOrder({ status: 'trash' }))).toBe(false)
  })
})

describe('mapOrder', () => {
  it('maps a paid order to one gross row dated by date_paid', () => {
    const rows = mapOrder('shop.example.se', makeOrder())
    expect(rows).toEqual([
      {
        date: '2026-08-01',
        description: 'WooCommerce-order #1042',
        amount: 1250,
        currency: 'SEK',
        external_id: 'woo_shop.example.se_order_1042',
        import_source: 'woocommerce',
        reference: 'pi_abc123',
      },
    ])
  })

  it('rounds string money to two decimals', () => {
    const rows = mapOrder('s', makeOrder({ total: '99.995' }))
    expect(rows[0].amount).toBe(100)
  })

  it('skips unpaid, trashed, zero-total and unparseable orders', () => {
    expect(mapOrder('s', makeOrder({ date_paid_gmt: null }))).toEqual([])
    expect(mapOrder('s', makeOrder({ status: 'trash' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ total: '0.00' }))).toEqual([])
    expect(mapOrder('s', makeOrder({ total: 'not-a-number' }))).toEqual([])
  })
})

describe('mapRefund', () => {
  const refund: WooRefund = {
    id: 77,
    amount: '250.00',
    reason: 'Retur',
    date_created_gmt: '2026-08-03T10:00:00',
  }

  it('maps a refund to one negative row dated by the refund date', () => {
    const rows = mapRefund('shop.example.se', makeOrder(), refund)
    expect(rows).toEqual([
      {
        date: '2026-08-03',
        description: 'WooCommerce-återbetalning order #1042',
        amount: -250,
        currency: 'SEK',
        external_id: 'woo_shop.example.se_refund_77',
        import_source: 'woocommerce',
        reference: null,
      },
    ])
  })

  it('skips zero-amount refunds', () => {
    expect(mapRefund('s', makeOrder(), { ...refund, amount: '0' })).toEqual([])
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

describe('syncWooCommerceOrders', () => {
  it('ingests order and refund rows against the 1680 cash account and advances the cursor', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({
      refunds: [{ id: 77, reason: 'Retur', total: '-250.00' }],
    })
    listOrdersPage.mockResolvedValueOnce(wooPage([order]))
    listOrderRefunds.mockResolvedValueOnce([
      { id: 77, amount: '250.00', reason: 'Retur', date_created_gmt: '2026-08-03T10:00:00' },
    ])
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 2,
      duplicates: 0,
      errors: 0,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary).toMatchObject({ fetched: 1, refundsFetched: 1, imported: 2, duplicates: 0 })
    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1680',
      'SEK',
      'WooCommerce-saldo',
    )
    expect(ingestTransactions).toHaveBeenCalledTimes(1)
    const [, companyId, userId, rows, ingestOptions] =
      vi.mocked(ingestTransactions).mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'woo_shop.example.se_order_1042',
      'woo_shop.example.se_refund_77',
    ])
    expect(ingestOptions).toEqual({ settlementAccount: '1680', skipAutoCategorization: true })

    // Cursor persisted from the page's max date_modified_gmt, then from the
    // successfully exhausted window's scanned-through watermark.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(3)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
    expect(cursors[0].values.error_message).toBeNull()
    expect(cursors[1].values.last_order_synced_at).toBe('2026-08-01T09:05:00.000Z')
    const watermarkMs = Date.parse(cursors[2].values.last_order_synced_at as string)
    expect(Math.abs(watermarkMs - Date.now())).toBeLessThan(60_000)

    // Second list call proves cursor pagination: modified_after advanced to
    // the last row's timestamp, page reset to 1, terminated by the empty page.
    expect(listOrdersPage).toHaveBeenCalledTimes(3)
    expect(listOrdersPage.mock.calls[1][1]).toEqual({
      modifiedAfter: '2026-08-01T09:04:59.000Z',
      modifiedBefore: '2026-08-01T09:05:01.000Z',
      orderBy: 'id',
      page: 1,
    })
  })

  it('drops rows dated on/before the bookkeeping lock on every run', async () => {
    const { client, updates } = makeSupabaseMock({ lockThrough: '2026-08-02' })
    // Order paid 2026-08-01 (behind lock), refund created 2026-08-03 (after).
    const order = makeOrder({ refunds: [{ id: 77, reason: '', total: '-250.00' }] })
    listOrdersPage.mockResolvedValueOnce(wooPage([order]))
    listOrderRefunds.mockResolvedValueOnce([
      { id: 77, amount: '250.00', reason: '', date_created_gmt: '2026-08-03T10:00:00' },
    ])

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.skippedLocked).toBe(1)
    const [, , , rows] = vi.mocked(ingestTransactions).mock.calls[0]
    expect((rows as Array<{ external_id: string }>).map((r) => r.external_id)).toEqual([
      'woo_shop.example.se_refund_77',
    ])
    // The cursor still advances: the drop is by design, not a failure.
    expect(cursorUpdates(updates)).toHaveLength(3)
  })

  it('holds the cursor below an order whose refund fetch failed', async () => {
    const { client, updates } = makeSupabaseMock()
    const order = makeOrder({ refunds: [{ id: 77, reason: '', total: '-250.00' }] })
    listOrdersPage.mockResolvedValueOnce(wooPage([order]))
    listOrderRefunds.mockRejectedValueOnce(new Error('502 from host'))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    // date_modified 09:05:00 minus 1s: the next run re-lists this order.
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('retries an earlier failed refund across invocations without persisting the later tail cohort', async () => {
    const seen = new Set<string>()
    const failed = makeOrder({
      id: 1,
      number: '1',
      date_modified_gmt: '2026-08-01T09:00:00',
      refunds: [{ id: 77, reason: '', total: '-10.00' }],
    })
    const tail = makeOrder({ id: 2, number: '2' })
    const firstDb = makeSupabaseMock({ seen })
    listOrdersPage.mockResolvedValueOnce(wooPage([failed, tail]))
    listOrderRefunds.mockRejectedValueOnce(new Error('502 from host'))

    const first = await syncWooCommerceOrders(firstDb.client, makeConnection())

    expect(first.errors).toBe(1)
    expect(listOrdersPage).toHaveBeenCalledTimes(1)
    expect(seen.size).toBe(0)
    expect(
      firstDb.updates.some(update => 'order_sync_cohort_modified_at' in update.values),
    ).toBe(false)
    const heldCursor = cursorUpdates(firstDb.updates).at(-1)?.values
      .last_order_synced_at as string
    expect(heldCursor).toBe('2026-08-01T08:59:59.000Z')

    listOrdersPage.mockClear()
    listOrderRefunds.mockClear()
    vi.mocked(ingestTransactions).mockClear()
    listOrdersPage.mockResolvedValueOnce(wooPage([failed, tail]))
    listOrderRefunds.mockRejectedValueOnce(new Error('502 from host again'))
    const secondDb = makeSupabaseMock({ seen })

    const second = await syncWooCommerceOrders(
      secondDb.client,
      makeConnection({ last_order_synced_at: heldCursor }),
    )

    expect(second.errors).toBe(1)
    expect(listOrdersPage).toHaveBeenCalledTimes(1)
    expect(listOrdersPage.mock.calls[0][1]).toMatchObject({
      modifiedAfter: '2026-07-31T08:59:59.000Z',
      orderBy: 'modified',
    })
    expect(listOrderRefunds).toHaveBeenCalledTimes(1)
    const retriedIds = vi.mocked(ingestTransactions).mock.calls.flatMap(call =>
      (call[3] as Array<{ external_id: string }>).map(row => row.external_id),
    )
    expect(retriedIds).toContain('woo_shop.example.se_order_1')
    expect(retriedIds).not.toContain('woo_shop.example.se_refund_77')
    expect(cursorUpdates(secondDb.updates)).toHaveLength(0)
    expect(seen.size).toBe(0)
    expect(
      secondDb.updates.some(update => 'order_sync_cohort_modified_at' in update.values),
    ).toBe(false)
  })

  it('verifies a same-timestamp cohort before resuming cursor pagination', async () => {
    const { client } = makeSupabaseMock()
    const tie = Array.from({ length: 100 }, (_, i) =>
      makeOrder({ id: i + 1, number: String(i + 1) }),
    )
    listOrdersPage
      .mockResolvedValueOnce(wooPage(tie))
      .mockResolvedValueOnce(wooPage(tie))
      .mockResolvedValueOnce(wooPage([]))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.fetched).toBe(200)
    const cohortCalls = listOrdersPage.mock.calls
      .map(call => call[1])
      .filter(options => options.orderBy === 'id')
    expect(cohortCalls.map(options => options.page)).toEqual([1])
  })

  it('does not skip a mixed-page tail when additional orders share its timestamp', async () => {
    const { client, updates } = makeSupabaseMock()
    const earlier = Array.from({ length: 50 }, (_, index) =>
      makeOrder({
        id: index + 1,
        number: String(index + 1),
        date_modified_gmt: '2026-08-01T09:00:00',
      }),
    )
    const fullTail = Array.from({ length: 100 }, (_, index) =>
      makeOrder({ id: index + 51, number: String(index + 51) }),
    )
    listOrdersPage
      .mockResolvedValueOnce(wooPage([...earlier, ...fullTail.slice(0, 50)]))
      .mockResolvedValueOnce(wooPage(fullTail))
      .mockResolvedValueOnce(wooPage(fullTail))
      .mockResolvedValueOnce(wooPage([]))

    await syncWooCommerceOrders(client, makeConnection())

    const importedIds = vi.mocked(ingestTransactions).mock.calls.flatMap(call =>
      (call[3] as Array<{ external_id: string }>).map(row => row.external_id),
    )
    expect(new Set(importedIds).size).toBe(150)
    expect(importedIds).toContain('woo_shop.example.se_order_150')
    const cohortCalls = listOrdersPage.mock.calls
      .map(call => call[1])
      .filter(options => options.orderBy === 'id')
    expect(cohortCalls.map(options => options.page)).toEqual([1, 1])
    expect(cursorUpdates(updates).at(-1)?.values.last_order_synced_at).not.toBe(
      '2026-08-01T09:04:59.000Z',
    )
  })

  it('resumes beyond a same-timestamp cohort larger than the per-run cap', async () => {
    const cohort = Array.from({ length: 10_050 }, (_, index) =>
      makeOrder({ id: index + 1, number: String(index + 1) }),
    )
    const provider = async (_creds: unknown, options: { orderBy?: string; page: number }) => {
      if (options.orderBy === 'modified') return wooPage(cohort.slice(0, 100), cohort.length, 101)
      const start = (options.page - 1) * 100
      return wooPage(cohort.slice(start, start + 100), cohort.length, 101, options.page)
    }
    listOrdersPage.mockImplementation(provider)
    let state = makeWooPersistedState()
    const firstDb = makeSupabaseMock({ state })

    const first = await syncWooCommerceOrders(firstDb.client, wooConnectionFromState(state))

    expect(first.deadlineReached).toBeUndefined()
    expect(first.fetched).toBe(10_000)
    const firstProgress = firstDb.updates
      .map(update => update.values)
      .filter(values => 'order_sync_cohort_page' in values)
      .at(-1)!
    expect(firstProgress.order_sync_cohort_page).toBe(100)

    vi.mocked(ingestTransactions).mockClear()
    listOrdersPage.mockClear()
    listOrdersPage.mockImplementation(provider)
    state = restartWooState(state)
    const secondDb = makeSupabaseMock({ state })
    const secondConnection = wooConnectionFromState(state)

    await syncWooCommerceOrders(secondDb.client, secondConnection)

    expect(listOrdersPage.mock.calls[0][1]).toMatchObject({
      orderBy: 'id',
      page: 100,
    })
    const secondRunIds = vi.mocked(ingestTransactions).mock.calls.flatMap(call =>
      (call[3] as Array<{ external_id: string }>).map(row => row.external_id),
    )
    expect(secondRunIds).toContain('woo_shop.example.se_order_10050')
  })

  it('persists the next cohort page when a deadline interrupts each invocation', async () => {
    const modifiedAt = '2026-08-01T09:05:00.000Z'
    const cohort = Array.from({ length: 102 }, (_, index) =>
      makeOrder({ id: index + 1, number: String(index + 1) }),
    )
    let state = makeWooPersistedState()
    state.order_sync_scan_modified_after = '2026-07-31T09:05:00.000Z'
    state.order_sync_cohort_modified_at = modifiedAt
    let nowMs = 0
    let crossOnPage = 2
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    listOrdersPage.mockImplementation(
      async (_creds: unknown, options: { page: number }) => {
        const start = (options.page - 1) * 100
        if (options.page === crossOnPage) nowMs = 10
        return wooPage(cohort.slice(start, start + 100), cohort.length, 2, options.page)
      },
    )
    vi.mocked(ingestTransactions).mockImplementation(async (_a, _b, _c, rows) => ({
      imported: rows.length,
      duplicates: 0,
      errors: 0,
    }) as Awaited<ReturnType<typeof ingestTransactions>>)

    try {
      const firstDb = makeSupabaseMock({ state })
      const firstConnection = wooConnectionFromState(state)
      const first = await syncWooCommerceOrders(
        firstDb.client,
        firstConnection,
        undefined,
        10,
      )
      expect(first.deadlineReached).toBe(true)
      const firstProgress = firstDb.updates.at(-1)!.values
      expect(firstProgress.order_sync_cohort_page).toBe(2)

      nowMs = 0
      crossOnPage = 1
      listOrdersPage.mockClear()
      vi.mocked(ingestTransactions).mockClear()
      state = restartWooState(state)
      const secondDb = makeSupabaseMock({ state })
      const second = await syncWooCommerceOrders(
        secondDb.client,
        wooConnectionFromState(state),
        undefined,
        10,
      )
      expect(second.deadlineReached).toBe(true)
      expect(listOrdersPage.mock.calls[0][1].page).toBe(2)
      const importedIds = vi.mocked(ingestTransactions).mock.calls.flatMap(call =>
        (call[3] as Array<{ external_id: string }>).map(row => row.external_id),
      )
      expect(importedIds).toContain('woo_shop.example.se_order_102')
    } finally {
      now.mockRestore()
    }
  })

  it('preserves an older exact cohort when its empty response crosses the deadline', async () => {
    const baseMs = Date.parse('2026-08-10T12:00:00.000Z')
    const deadlineMs = baseMs + 10
    vi.useFakeTimers()
    vi.setSystemTime(baseMs)
    const state = makeWooPersistedState()
    state.last_order_synced_at = '2026-08-05T12:00:00.000Z'
    state.order_sync_cohort_modified_at = '2026-08-01T09:05:00.000Z'
    state.order_sync_cohort_page = 2
    state.seen.add('conn-1:2026-08-01T09:05:00.000Z:1042')
    listOrdersPage.mockImplementationOnce(async () => {
      vi.setSystemTime(deadlineMs)
      return wooPage([])
    })

    try {
      const first = await syncWooCommerceOrders(
        makeSupabaseMock({ state }).client,
        wooConnectionFromState(state),
        undefined,
        deadlineMs,
      )
      expect(first.deadlineReached).toBe(true)
      expect(state.order_sync_cohort_modified_at).toBe('2026-08-01T09:05:00.000Z')
      expect(state.order_sync_cohort_page).toBe(2)
      expect(state.seen.size).toBe(1)

      vi.setSystemTime(baseMs)
      listOrdersPage.mockReset()
      listOrdersPage.mockResolvedValue(wooPage([]))
      await syncWooCommerceOrders(
        makeSupabaseMock({ state }).client,
        wooConnectionFromState(state),
        undefined,
        baseMs + 1_000,
      )
      expect(state.order_sync_cohort_modified_at).toBeNull()
      expect(state.seen.size).toBe(0)
      expect(state.last_order_synced_at).toBe('2026-08-10T12:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loudly at the cohort marker bound without advancing the cohort page', async () => {
    const state = makeWooPersistedState()
    state.order_sync_cohort_modified_at = '2026-08-01T09:05:00.000Z'
    listOrdersPage.mockResolvedValueOnce(wooPage([makeOrder()]))

    await expect(syncWooCommerceOrders(
      makeSupabaseMock({ state, markerLimit: 0 }).client,
      wooConnectionFromState(state),
    )).rejects.toThrow(/marker limit exceeded/)
    expect(state.order_sync_cohort_page).toBe(1)
    expect(state.seen.size).toBe(0)
  })

  it('falls back to the first order currency when store settings were unreadable', async () => {
    const { client } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(wooPage([makeOrder({ currency: 'eur' })]))

    await syncWooCommerceOrders(client, makeConnection({ currency: null }))

    expect(ensureManualCashAccount).toHaveBeenCalledWith(
      client,
      'company-1',
      '1680',
      'EUR',
      'WooCommerce-saldo',
    )
  })

  it('surfaces a cash-account failure on the connection instead of failing silently', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(wooPage([makeOrder()]))
    vi.mocked(ensureManualCashAccount).mockRejectedValueOnce(
      new Error('cash account 1680 exists with currency EUR'),
    )

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /confirmed outcome/,
    )
    const errorUpdate = updates.find(
      (u) => u.table === 'woocommerce_connections' && 'error_message' in u.values,
    )
    expect(errorUpdate?.values.error_message).toMatch(/1680/)
  })

  it('keeps an unparseable order total incomplete without crossing it', async () => {
    const state = makeWooPersistedState()
    const { client, updates } = makeSupabaseMock({ state })
    listOrdersPage.mockResolvedValueOnce(wooPage([makeOrder({ total: 'not-a-number' })]))

    await expect(syncWooCommerceOrders(client, wooConnectionFromState(state))).rejects.toThrow(
      /malformed and remains pending/,
    )
    expect(ingestTransactions).not.toHaveBeenCalled()
    expect(cursorUpdates(updates)).toHaveLength(1)
    expect(cursorUpdates(updates)[0].values.last_order_synced_at).toBe(
      '2026-08-01T09:04:59.000Z',
    )
    expect(state.order_sync_scan_modified_after).not.toBeNull()
    expect(state.seen.size).toBe(0)
  })

  it('advances a first-run quiet store to the scanned-through run start only', async () => {
    const runStartMs = Date.parse('2026-08-10T12:00:00.000Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(runStartMs)
    const { client, updates } = makeSupabaseMock()

    try {
      const summary = await syncWooCommerceOrders(client, makeConnection())

      expect(summary.fetched).toBe(0)
      expect(cursorUpdates(updates)).toEqual([
        {
          table: 'woocommerce_connections',
          values: {
            last_order_synced_at: '2026-08-10T12:00:00.000Z',
            order_sync_scan_modified_after: null,
            error_message: null,
          },
        },
      ])
      expect(ensureManualCashAccount).not.toHaveBeenCalled()
      expect(ingestTransactions).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })

  it('advances an incremental quiet store and preserves the 24h overlap', async () => {
    const runStartMs = Date.parse('2026-08-10T12:00:00.000Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(runStartMs)
    const { client, updates } = makeSupabaseMock()

    try {
      await syncWooCommerceOrders(
        client,
        makeConnection({ last_order_synced_at: '2026-08-05T12:00:00.000Z' }),
      )

      expect(listOrdersPage.mock.calls[0][1]).toEqual({
        modifiedAfter: '2026-08-04T12:00:00.000Z',
        orderBy: 'modified',
        page: 1,
      })
      expect(cursorUpdates(updates)[0].values.last_order_synced_at).toBe(
        '2026-08-10T12:00:00.000Z',
      )
    } finally {
      now.mockRestore()
    }
  })

  it('recovers a future cursor through the documented initial lookback', async () => {
    const runStartMs = Date.parse('2026-08-10T12:00:00.000Z')
    const now = vi.spyOn(Date, 'now').mockReturnValue(runStartMs)
    const { client, updates } = makeSupabaseMock()

    try {
      await syncWooCommerceOrders(
        client,
        makeConnection({ last_order_synced_at: '2026-08-11T12:00:00.000Z' }),
      )

      expect(listOrdersPage.mock.calls[0][1]).toMatchObject({
        modifiedAfter: '2026-05-12T12:00:00.000Z',
      })
      expect(cursorUpdates(updates)).toEqual([
        {
          table: 'woocommerce_connections',
          values: {
            last_order_synced_at: '2026-08-10T12:00:00.000Z',
            order_sync_scan_modified_after: null,
            error_message: null,
          },
        },
      ])
    } finally {
      now.mockRestore()
    }
  })

  it('does not advance a quiet store when listing fails', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('502 from host'))

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /502 from host/,
    )
    expect(cursorUpdates(updates)).toHaveLength(0)
  })

  it('does not apply the scanned-through watermark after an ingest error', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(wooPage([makeOrder()]))
    vi.mocked(ingestTransactions).mockResolvedValueOnce({
      imported: 0,
      duplicates: 0,
      errors: 1,
    } as Awaited<ReturnType<typeof ingestTransactions>>)

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.errors).toBe(1)
    const cursors = cursorUpdates(updates)
    expect(cursors).toHaveLength(1)
    expect(cursors[0].values.last_order_synced_at).toBe('2026-08-01T09:04:59.000Z')
  })

  it('fails loudly when the quiet-store cursor update fails', async () => {
    const { client } = makeSupabaseMock({ updateError: { message: 'database unavailable' } })

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /Failed to persist WooCommerce order progress: database unavailable/,
    )
  })

  it('fails loudly when the quiet-store cursor update matches no row', async () => {
    const { client } = makeSupabaseMock({ updateMatched: false })

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /Failed to persist WooCommerce order progress for conn-1/,
    )
  })

  it('fails before listing or advancing when the lock-date read fails', async () => {
    const { client, updates } = makeSupabaseMock({
      lockError: { message: 'settings unavailable' },
    })

    await expect(syncWooCommerceOrders(client, makeConnection())).rejects.toThrow(
      /Failed to fetch company lock date: settings unavailable/,
    )
    expect(listOrdersPage).not.toHaveBeenCalled()
    expect(cursorUpdates(updates)).toHaveLength(0)
  })

  it('does nothing for a connection without credentials or not active', async () => {
    const { client } = makeSupabaseMock()
    const summary = await syncWooCommerceOrders(
      client,
      makeConnection({ consumer_key_encrypted: null }),
    )
    expect(summary.fetched).toBe(0)
    expect(listOrdersPage).not.toHaveBeenCalled()

    const revokedSummary = await syncWooCommerceOrders(
      client,
      makeConnection({ status: 'revoked' }),
    )
    expect(revokedSummary.fetched).toBe(0)
  })

  it('flips the connection to revoked when the store rejects the credentials', async () => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockRejectedValueOnce(new Error('REVOKED'))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    const revokeUpdate = updates.find((u) => u.values.status === 'revoked')
    expect(revokeUpdate?.values.status).toBe('revoked')
  })

  it.each([401, 403])(
    'propagates refund-time HTTP %i and durably revokes the connection',
    async status => {
    const { client, updates } = makeSupabaseMock()
    listOrdersPage.mockResolvedValueOnce(wooPage([
      makeOrder({ refunds: [{ id: 77, reason: '', total: '-10.00' }] }),
    ]))
    listOrderRefunds.mockRejectedValueOnce(new Error(`REVOKED_${status}`))

    const summary = await syncWooCommerceOrders(client, makeConnection())

    expect(summary.revoked).toBe(true)
    expect(summary.errors).toBe(0)
    expect(
      updates.find(update => update.values.status === 'revoked')?.values,
    ).toMatchObject({
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
    })
    },
  )

  it('fails instead of reporting refund-time revocation when its DB write fails', async () => {
    const { client } = makeSupabaseMock({
      updateError: { message: 'revocation write unavailable' },
    })
    listOrdersPage.mockResolvedValueOnce(wooPage([
      makeOrder({ refunds: [{ id: 77, reason: '', total: '-10.00' }] }),
    ]))
    listOrderRefunds.mockRejectedValueOnce(new Error('REVOKED'))

    await expect(syncWooCommerceOrders(client, makeConnection({
      order_sync_scan_modified_after: '2026-05-01T00:00:00.000Z',
    }))).rejects.toThrow(
      /Failed to persist WooCommerce credential revocation: revocation write unavailable/,
    )
  })

  it('stops before fetching when the deadline is already reached', async () => {
    const { client, updates } = makeSupabaseMock()
    const summary = await syncWooCommerceOrders(
      client,
      makeConnection(),
      undefined,
      Date.now() - 1,
    )
    expect(summary.deadlineReached).toBe(true)
    expect(listOrdersPage).not.toHaveBeenCalled()
    expect(cursorUpdates(updates)).toHaveLength(0)
  })

  it('does not process a page whose list response crosses the deadline', async () => {
    const { client, updates } = makeSupabaseMock()
    const refunded = makeOrder({ refunds: [{ id: 77, reason: '', total: '-1.00' }] })
    // The list call itself consumes the whole budget, so the deadline is
    // comfortably alive at the loop check and expired by the refund loop.
    const deadlineMs = Date.now() + 200
    listOrdersPage.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return wooPage([refunded])
    })
    const summary = await syncWooCommerceOrders(client, makeConnection(), undefined, deadlineMs)

    expect(summary.deadlineReached).toBe(true)
    expect(listOrderRefunds).not.toHaveBeenCalled()
    expect(cursorUpdates(updates)).toHaveLength(0)
  })
})
