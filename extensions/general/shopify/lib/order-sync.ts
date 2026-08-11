import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import {
  CommerceSyncPersistenceError,
  CommerceSyncProviderError,
} from '@/lib/commerce/order-sync-errors'
import {
  awaitCommerceOperation,
  awaitDurableCommerceOperation,
  canonicalInstant,
  deadlineReached,
  sameInstant,
} from '@/lib/commerce/order-sync-runtime'
import type { RawTransaction } from '@/types'
import {
  createShopifySession,
  isRevokedCredentialsError,
  listOrdersPage,
} from './api-client'
import { credentialsOf } from './credentials'
import type { ShopifyConnection, ShopifyOrder, ShopifyRefund } from '../types'

const defaultLog = createLogger('shopify/order-sync')

/**
 * Shopify order sync: the store's paid orders and refunds treated as a
 * bank-style feed.
 *
 * The store becomes a cash account on ledger 1584 (Fordringar Shopify
 * Payments in the 158x sub-account convention: money the payment gateways owe
 * the merchant), and orders land in the transactions inbox exactly like PSD2
 * bank rows: deduped on external_id, bound to the cash account so booking
 * settles against 1584, and categorized/booked by the user through the normal
 * flows. Nothing here auto-books (feed-only doctrine, same as the Stripe and
 * WooCommerce feeds). 1680 and 1686 are owned by those feeds, and
 * cash_accounts enforces one account per ledger per company.
 *
 * Row model: a paid order produces one positive row for its gross total; each
 * refund produces one negative row. Payment-processor fees never appear in
 * this feed: order-level fee data only exists for Shopify Payments and payout
 * reconciliation is a separate concern (phase 2); external gateways (Klarna,
 * Stripe) report no fees through Shopify at all. The gateway names ride along
 * as the row reference for later gateway-side reconciliation.
 *
 * Pagination: one durable updated_at window is split into exact timestamp
 * cohorts. Relay continuation is persisted only for an exact-cohort query,
 * so its query identity never changes across invocations. Each cohort is
 * replayed from page one until one complete pass finds no unseen provider ID;
 * durable completion markers make mutation or cursor reordering cause replay,
 * never omission. Only provider exhaustion advances last_order_synced_at to
 * the fixed window maximum. The next scan re-polls a 24h overlap, while first
 * run fetches BACKFILL_DAYS back.
 *
 * Lock-date guard: the window selects on updatedAt, but rows are dated by
 * processedAt / refund createdAt, which can be arbitrarily older (a refund
 * bumps updatedAt long after payment). Rows dated on or before
 * company_settings.bookkeeping_locked_through are therefore dropped at map
 * time on EVERY run: the enforce_company_lock_date trigger makes them
 * permanently unbookable, and feed rows are undeletable by design, so
 * importing them would create permanent inbox noise. Dropped rows are counted
 * in skippedLocked and logged.
 */

/** BAS ledger account for the Shopify store cash account. */
export const SHOPIFY_LEDGER_ACCOUNT = '1584'
/** 158x sub-account name (e-handel convention); used for the chart account. */
const SHOPIFY_LEDGER_ACCOUNT_NAME = 'Fordringar Shopify Payments'
/** transactions.import_source for Shopify feed rows. */
export const SHOPIFY_IMPORT_SOURCE = 'shopify'
/** First-run backfill window (matches the WooCommerce/Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; external_id dedup makes duplicates no-ops. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe/WooCommerce feeds). The
 * real bound is the caller's deadline; hitting this cap is logged loudly
 * because a silent cap reads as "covered everything" when it did not. The
 * cursor resumes where a truncated run stopped.
 */
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to transactions.external_id and
 * dedup compares stored ids byte-for-byte, exactly like the Stripe, Enable
 * Banking and WooCommerce schemes. Changing a template silently orphans every
 * prior row and re-imports the whole feed on the next sync. Locked by the
 * frozen-format test in order-sync.test.ts; any change MUST ship a
 * coordinated backfill.
 *
 * The scope is the store's normalized myshopify.com domain, NOT the
 * connection id, so a disconnect/reconnect of the same store keeps every
 * previously imported row deduped. The ids are Shopify's numeric
 * legacyResourceIds, matching the shopify_order_{id} convention the MCP
 * agent path already uses (different prefix, so the two paths never collide
 * on the same rows by accident).
 */
export function shopifyShopScope(shopDomain: string): string {
  return shopDomain
}

export function shopifyOrderExternalId(shopScope: string, orderId: string): string {
  return `shopify_${shopScope}_order_${orderId}`
}

export function shopifyRefundExternalId(shopScope: string, refundId: string): string {
  return `shopify_${shopScope}_refund_${refundId}`
}

export interface ShopifySyncSummary {
  /** Orders listed from the store (all statuses in the window). */
  fetched: number
  /** Refund objects seen on qualifying orders in the window. */
  refundsFetched: number
  /** New inbox rows inserted. */
  imported: number
  /** Rows skipped by external_id / content dedup. */
  duplicates: number
  /** Rows dropped because they are dated on/before the bookkeeping lock. */
  skippedLocked: number
  errors: number
  /** Set when the caller's time budget ran out before all pages processed. */
  deadlineReached?: boolean
  /** Set when the store reported the credentials revoked (401/403). */
  revoked?: boolean
}

/**
 * Money fields arrive as decimal strings in major units for every currency
 * (GraphQL MoneyV2; zero-decimal currencies like JPY included, so never
 * divide by 100). Unparseable input returns null so callers can tell a
 * corrupt total (counted + logged) from a legitimate zero (silently skipped).
 */
function parseAmount(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? roundOre(parsed) : null
}

/** Whether a qualifying order's total cannot be read as money. */
export function orderAmountUnparseable(order: Pick<ShopifyOrder, 'totalPriceSet'>): boolean {
  return parseAmount(order.totalPriceSet.shopMoney.amount) === null
}

/** Date part of an ISO timestamp. */
function isoDateOf(timestamp: string): string {
  return timestamp.split('T')[0]
}

/**
 * Financial statuses that mean the order has been paid (possibly later
 * refunded). AUTHORIZED/PENDING/PARTIALLY_PAID orders carry no settled
 * revenue yet and EXPIRED/VOIDED never will; they re-surface via updatedAt
 * once payment captures. REFUNDED stays IN: a fully refunded order was still
 * paid, and its refunds land as separate negative rows so the pair nets to
 * zero instead of the gross silently disappearing.
 */
const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'])

/**
 * Whether an order belongs in the feed: it must have been paid and not be a
 * test-gateway order (dev stores, Bogus Gateway: never real revenue).
 */
export function orderQualifies(
  order: Pick<ShopifyOrder, 'test' | 'displayFinancialStatus'>,
): boolean {
  return !order.test && PAID_STATUSES.has(order.displayFinancialStatus ?? '')
}

/**
 * Map a paid order to its gross feed row. Dates use processedAt (when the
 * money event happened), not createdAt: booked entries, invoice matching, and
 * month boundaries all want the payment date. Descriptions are deterministic
 * from immutable data (order names never change) because the content-dedup
 * bridge keys off them.
 */
export function mapOrder(shopScope: string, order: ShopifyOrder): RawTransaction[] {
  if (!orderQualifies(order)) return []
  const amount = parseAmount(order.totalPriceSet.shopMoney.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOf(order.processedAt),
      description: `Shopify-order ${order.name}`,
      amount,
      currency: order.totalPriceSet.shopMoney.currencyCode.toUpperCase(),
      external_id: shopifyOrderExternalId(shopScope, order.legacyResourceId),
      import_source: SHOPIFY_IMPORT_SOURCE,
      reference: order.paymentGatewayNames.join(', ') || null,
    },
  ]
}

/** Map one refund of a paid order to its negative feed row. */
export function mapRefund(
  shopScope: string,
  order: Pick<ShopifyOrder, 'name'>,
  refund: ShopifyRefund,
): RawTransaction[] {
  const amount = parseAmount(refund.totalRefundedSet.shopMoney.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOf(refund.createdAt),
      description: `Shopify-återbetalning order ${order.name}`,
      amount: -amount,
      currency: refund.totalRefundedSet.shopMoney.currencyCode.toUpperCase(),
      external_id: shopifyRefundExternalId(shopScope, refund.legacyResourceId),
      import_source: SHOPIFY_IMPORT_SOURCE,
      reference: null,
    },
  ]
}

/** Company lock date (YYYY-MM-DD) or null; read once per run. */
async function fetchLockThrough(
  supabase: SupabaseClient,
  companyId: string,
  deadlineMs?: number,
): Promise<string | null> {
  const query = supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', companyId)
    .maybeSingle()
  const { data: settings, error } = await awaitCommerceOperation(
    query,
    deadlineMs,
    'fetch Shopify bookkeeping lock',
  )
  if (error) throw new Error(`Failed to fetch company lock date: ${error.message}`)
  return (
    (settings as { bookkeeping_locked_through?: string | null } | null)
      ?.bookkeeping_locked_through ?? null
  )
}

/** Whether a feed-row date is on/before the lock date (=> never bookable). */
export function rowBehindLock(rowDate: string, lockThrough: string | null): boolean {
  return lockThrough !== null && rowDate <= lockThrough
}

/**
 * Window start (ISO, UTC) for the updated_at filter. With a cursor: cursor
 * minus the 24h overlap. First run: BACKFILL_DAYS back. (The lock date does
 * not floor the window: it selects on updatedAt while rows are dated by
 * processedAt, so the real guard is rowBehindLock at map time, every run.)
 */
function resolveWindowStartIso(connection: ShopifyConnection, runStartMs: number): string {
  if (
    connection.last_order_synced_at &&
    Date.parse(connection.last_order_synced_at) <= runStartMs
  ) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(runStartMs - BACKFILL_DAYS * 86_400_000).toISOString()
}

function requireClaimToken(connection: ShopifyConnection): string {
  if (!connection.order_sync_claim_token) {
    throw new CommerceSyncPersistenceError(
      'Shopify sync has no exact claim token',
      'lease_validation',
    )
  }
  return connection.order_sync_claim_token
}

async function validateActiveLease(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase
    .from('shopify_connections')
    .select('id')
    .eq('id', connection.id)
    .eq('status', 'active')
    .eq('order_sync_claim_token', requireClaimToken(connection))
    .gt('order_sync_claimed_until', new Date().toISOString())
    .maybeSingle()
  const { data, error } = await awaitCommerceOperation(
    query,
    deadlineMs,
    'validate Shopify sync lease',
  )
  if (error || !data) {
    throw new CommerceSyncPersistenceError(
      `Shopify sync lease is no longer active${error ? `: ${error.message}` : ''}`,
      'lease_validation',
      summary,
    )
  }
}

async function fetchSeenOrderIds(
  supabase: SupabaseClient,
  connectionId: string,
  updatedAt: string,
  orderIds: string[],
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set()
  const query = supabase
    .from('shopify_order_sync_seen')
    .select('order_id')
    .eq('connection_id', connectionId)
    .eq('updated_at', updatedAt)
    .in('order_id', orderIds)
  const { data, error } = await awaitCommerceOperation(
    query,
    deadlineMs,
    'read Shopify cohort markers',
  )
  if (error) {
    throw new CommerceSyncPersistenceError(
      `Failed to read Shopify cohort progress: ${error.message}`,
      'cohort_read',
      summary,
    )
  }
  return new Set((data ?? []).map(row => String((row as { order_id: string }).order_id)))
}

async function checkpointShopifyScan(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  state: {
    scanMinUpdatedAt: string
    scanMinInclusive: boolean
    scanMaxUpdatedAt: string
    cohortUpdatedAt: string | null
    after: string | null
    passFoundNew: boolean
  },
  completedOrderIds: string[],
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('checkpoint_shopify_order_sync', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_scan_min_updated_at: state.scanMinUpdatedAt,
    p_scan_min_inclusive: state.scanMinInclusive,
    p_scan_max_updated_at: state.scanMaxUpdatedAt,
    p_cohort_updated_at: state.cohortUpdatedAt,
    p_after: state.after,
    p_pass_found_new: state.passFoundNew,
    p_completed_order_ids: completedOrderIds,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'checkpoint Shopify order scan',
    'scan_checkpoint',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to checkpoint Shopify order scan${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
      'scan_checkpoint',
      summary,
    )
  }
}

async function completeShopifyCohort(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  cohortUpdatedAt: string,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('complete_shopify_order_sync_cohort', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_cohort_updated_at: cohortUpdatedAt,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'complete Shopify cohort',
    'cohort_completion',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to complete Shopify order cohort${error ? `: ${error.message}` : ': exact active lease and cohort were not matched'}`,
      'cohort_completion',
      summary,
    )
  }
}

async function completeShopifyScan(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  scanMaxUpdatedAt: string,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('complete_shopify_order_sync', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_scan_max_updated_at: scanMaxUpdatedAt,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'complete Shopify scan',
    'scan_completion',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to complete Shopify order scan${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
      'scan_completion',
      summary,
    )
  }
  connection.last_order_synced_at = scanMaxUpdatedAt
  connection.order_sync_scan_min_updated_at = null
  connection.order_sync_scan_min_inclusive = true
  connection.order_sync_scan_max_updated_at = null
  connection.order_sync_scan_cohort_updated_at = null
  connection.order_sync_scan_after = null
  connection.order_sync_scan_pass_found_new = false
}

async function revokeShopifyConnection(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('revoke_commerce_connection_for_sync', {
    p_provider: 'shopify',
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_error_message: 'Butiken avvisade appens uppgifter. Anslut butiken igen.',
    p_disconnected_at: new Date().toISOString(),
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'persist Shopify credential revocation',
    'credential_revocation',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to persist Shopify credential revocation${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
      'credential_revocation',
      summary,
    )
  }
}

async function persistShopifyConnectionError(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  message: string,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase
    .from('shopify_connections')
    .update({ error_message: message })
    .eq('id', connection.id)
    .eq('status', 'active')
    .eq('order_sync_claim_token', requireClaimToken(connection))
    .select('id')
    .maybeSingle()
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'persist Shopify connection error',
    'connection_error',
    summary,
  )
  if (error || !data) {
    throw new CommerceSyncPersistenceError(
      `Failed to persist Shopify connection error${error ? `: ${error.message}` : ''}`,
      'connection_error',
    )
  }
}

/**
 * Make sure the store cash account exists (ledger 1584, source manual so a
 * later remap/promotion follows the normal cash-account rules) and, on the
 * first run, that 1584 exists in the chart of accounts: the booking dialog
 * and AccountPicker only list chart accounts.
 *
 * Currency comes from the shop settings read at connect time, falling back to
 * the first fetched order's real currency (guessing SEK for an EUR store
 * would poison the account). A conflict with an existing 1584 cash account
 * throws; the caller surfaces that on the connection so the panel shows why
 * nothing syncs.
 */
async function ensureStoreAccount(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  fallbackCurrency: string | undefined,
  firstRun: boolean,
  log: Logger,
  claimToken: string,
  summary: ShopifySyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const currency =
    connection.currency?.toUpperCase() || fallbackCurrency?.toUpperCase() || 'SEK'
  try {
    await ensureManualCashAccount(
      supabase,
      connection.company_id,
      SHOPIFY_LEDGER_ACCOUNT,
      currency,
      'Shopify-saldo',
    )
  } catch (accountError) {
    // Typically a currency conflict with an existing 1584 cash account. Made
    // visible on the connection: without this the panel shows a healthy
    // "Ansluten" store that silently never syncs.
    connection.order_sync_claim_token = claimToken
    await persistShopifyConnectionError(
      supabase,
      connection,
      'Kassakontot för butiken (1584) kunde inte skapas. Kontrollera att befintligt konto 1584 har samma valuta som butiken.',
      summary,
      deadlineMs,
    )
    throw accountError
  }
  if (firstRun) {
    const sync = await syncMappedAccounts(
      supabase,
      connection.company_id,
      connection.user_id,
      [
        {
          sourceAccount: SHOPIFY_LEDGER_ACCOUNT,
          sourceName: SHOPIFY_LEDGER_ACCOUNT_NAME,
          targetAccount: SHOPIFY_LEDGER_ACCOUNT,
          targetName: SHOPIFY_LEDGER_ACCOUNT_NAME,
          confidence: 1,
          matchType: 'exact',
          isOverride: false,
        },
      ],
      false,
    )
    if (sync.error) {
      // Rows still import and bind to the cash account; only the chart
      // listing is affected (the account can be added manually), so this is
      // deliberately non-fatal.
      log.warn('chart sync for 1584 failed', {
        companyId: connection.company_id,
        error: sync.error,
      })
    }
  }
}

/** Rows for one page of orders: gross rows plus inline refund rows. */
function buildPageRows(
  shopScope: string,
  orders: ShopifyOrder[],
  lockThrough: string | null,
  summary: ShopifySyncSummary,
  log: Logger,
): { rows: RawTransaction[]; incompleteOrderIds: Set<string> } {
  const rows: RawTransaction[] = []
  const incompleteOrderIds = new Set<string>()

  const push = (mapped: RawTransaction[]) => {
    for (const row of mapped) {
      if (rowBehindLock(row.date, lockThrough)) {
        summary.skippedLocked += 1
        continue
      }
      rows.push(row)
    }
  }

  for (const order of orders) {
    // A corrupt total is counted and logged, never silently identical to a
    // zero-total order. Deliberately NOT held via the cursor: a permanently
    // corrupt total would stall the whole feed forever, where a skipped row
    // plus a loud error can be followed up.
    if (orderQualifies(order) && orderAmountUnparseable(order)) {
      summary.errors += 1
      log.warn('unparseable order total; row skipped', {
        orderId: order.legacyResourceId,
        total: order.totalPriceSet.shopMoney.amount,
      })
      incompleteOrderIds.add(order.legacyResourceId)
    }
    push(mapOrder(shopScope, order))
    // Refunds only exist in the feed for qualifying (paid) orders: a refund
    // row without its gross counterpart would be an unexplainable negative in
    // the inbox. They come inline on the order (no follow-up request).
    if (!orderQualifies(order)) continue
    for (const refund of order.refunds) {
      summary.refundsFetched += 1
      if (parseAmount(refund.totalRefundedSet.shopMoney.amount) === null) {
        summary.errors += 1
        log.warn('unparseable refund amount; row skipped', {
          orderId: order.legacyResourceId,
          refundId: refund.legacyResourceId,
          amount: refund.totalRefundedSet.shopMoney.amount,
        })
        incompleteOrderIds.add(order.legacyResourceId)
      }
      push(mapRefund(shopScope, order, refund))
    }
  }
  return { rows, incompleteOrderIds }
}

export async function syncShopifyOrders(
  supabase: SupabaseClient,
  connection: ShopifyConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget. Enforced
   * between pages: the cursor advances only over fully-processed pages, so
   * the next run resumes exactly where this one stopped.
   */
  deadlineMs?: number,
): Promise<ShopifySyncSummary> {
  const summary: ShopifySyncSummary = {
    fetched: 0,
    refundsFetched: 0,
    imported: 0,
    duplicates: 0,
    skippedLocked: 0,
    errors: 0,
  }
  if (
    connection.status !== 'active' ||
    !connection.client_id_encrypted ||
    !connection.client_secret_encrypted
  ) {
    return summary
  }

  const runStartMs = Date.now()
  const shopScope = shopifyShopScope(connection.shop_domain)
  const firstRun = !connection.last_order_synced_at
  const claimToken = requireClaimToken(connection)
  const resumingScan = connection.order_sync_scan_max_updated_at !== null
  const scanMaxUpdatedAt = connection.order_sync_scan_max_updated_at
    ? canonicalInstant(connection.order_sync_scan_max_updated_at, 'Shopify scan maximum')
    : new Date(runStartMs).toISOString()
  let scanMinUpdatedAt = connection.order_sync_scan_min_updated_at
    ? canonicalInstant(connection.order_sync_scan_min_updated_at, 'Shopify scan minimum')
    : resolveWindowStartIso(connection, runStartMs)
  let scanMinInclusive = resumingScan
    ? connection.order_sync_scan_min_inclusive
    : true
  let cohortUpdatedAt = connection.order_sync_scan_cohort_updated_at
    ? canonicalInstant(connection.order_sync_scan_cohort_updated_at, 'Shopify cohort')
    : null
  let after = connection.order_sync_scan_after ?? null
  let cohortPassFoundNew = connection.order_sync_scan_pass_found_new ?? false
  let scannedThisRun = 0
  let accountEnsured = false

  if (deadlineReached(deadlineMs)) {
    summary.deadlineReached = true
    return summary
  }

  const durableState = () => ({
    scanMinUpdatedAt,
    scanMinInclusive,
    scanMaxUpdatedAt,
    cohortUpdatedAt,
    after,
    passFoundNew: cohortPassFoundNew,
  })

  try {
    const lockThrough = await fetchLockThrough(supabase, connection.company_id, deadlineMs)
    if (deadlineReached(deadlineMs)) {
      summary.deadlineReached = true
      return summary
    }
    if (!resumingScan) {
      await checkpointShopifyScan(
        supabase,
        connection,
        durableState(),
        [],
        summary,
        deadlineMs,
      )
    }
    if (deadlineReached(deadlineMs)) {
      summary.deadlineReached = true
      return summary
    }
    // Token exchange happens up front (the token lives ~24h, far longer than
    // any run); a dead client secret surfaces here as a revoked-classified
    // error before any paging starts.
    const session = await createShopifySession(credentialsOf(connection), {
      startDeadlineMs: deadlineMs,
    })

    for (;;) {
      if (deadlineReached(deadlineMs)) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.imported + summary.duplicates,
        })
        break
      }

      if (cohortUpdatedAt === null) {
        const discovery = await listOrdersPage(session, {
          updatedAtMin: scanMinUpdatedAt,
          updatedAtMinInclusive: scanMinInclusive,
          updatedAtMax: scanMaxUpdatedAt,
          after: null,
        }, { startDeadlineMs: deadlineMs })
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          summary.deadlineReached = true
          break
        }
        if (discovery.orders.length === 0) {
          await completeShopifyScan(supabase, connection, scanMaxUpdatedAt, summary, deadlineMs)
          break
        }
        cohortUpdatedAt = canonicalInstant(discovery.orders[0].updatedAt, 'Shopify updatedAt')
        after = null
        cohortPassFoundNew = false
        await checkpointShopifyScan(
          supabase,
          connection,
          durableState(),
          [],
          summary,
          deadlineMs,
        )
        continue
      }

      let page
      try {
        page = await listOrdersPage(session, {
          updatedAtMin: cohortUpdatedAt,
          updatedAtMinInclusive: true,
          updatedAtMax: cohortUpdatedAt,
          after,
        }, { startDeadlineMs: deadlineMs })
      } catch (error) {
        // Relay cursors are scoped to this fixed exact-cohort query, but a
        // provider mutation can still invalidate the opaque continuation.
        // Reset only the continuation and retain completion markers so a
        // fresh invocation safely replays from page one without omission.
        if (after !== null) {
          after = null
          await checkpointShopifyScan(
            supabase,
            connection,
            durableState(),
            [],
            summary,
            deadlineMs,
          )
        }
        throw error
      }
      if (deadlineReached(deadlineMs)) {
        summary.deadlineReached = true
        break
      }
      if (page.orders.length === 0) {
        if (cohortPassFoundNew) {
          after = null
          cohortPassFoundNew = false
          await checkpointShopifyScan(
            supabase,
            connection,
            durableState(),
            [],
            summary,
            deadlineMs,
          )
          continue
        }
        const completedCohort = cohortUpdatedAt
        await completeShopifyCohort(
          supabase,
          connection,
          completedCohort,
          summary,
          deadlineMs,
        )
        scanMinUpdatedAt = completedCohort
        scanMinInclusive = false
        cohortUpdatedAt = null
        after = null
        cohortPassFoundNew = false
        continue
      }
      summary.fetched += page.orders.length
      scannedThisRun += page.orders.length
      const exactOrders = page.orders.filter(order => sameInstant(order.updatedAt, cohortUpdatedAt!))
      if (exactOrders.length !== page.orders.length) {
        throw new Error('Shopify exact-cohort query returned a different updatedAt')
      }
      const seenOrderIds = await fetchSeenOrderIds(
        supabase,
        connection.id,
        cohortUpdatedAt,
        exactOrders.map(order => order.legacyResourceId),
        summary,
        deadlineMs,
      )
      const workOrders = exactOrders.filter(
        order => !seenOrderIds.has(order.legacyResourceId),
      )

      // Deferred until there is unseen work; verification pages must not index
      // an empty workOrders array or recreate the cash account unnecessarily.
      if (!accountEnsured && workOrders.length > 0) {
        await awaitDurableCommerceOperation(
          ensureStoreAccount(
            supabase,
            connection,
            workOrders[0].totalPriceSet.shopMoney.currencyCode,
            firstRun,
            log,
            claimToken,
            summary,
            deadlineMs,
          ),
          deadlineMs,
          'ensure Shopify store account',
          'store_account_setup',
          summary,
        )
        accountEnsured = true
      }

      const pageRows = buildPageRows(shopScope, workOrders, lockThrough, summary, log)

      let ingestHadErrors = false
      if (pageRows.rows.length > 0) {
        // Auto-categorization is skipped on purpose: booking Shopify money is
        // a human decision in the inbox (feed-only doctrine, same as the
        // Stripe and WooCommerce feeds). Invoice matching still runs
        // (suggestions only), and FX enrichment covers non-SEK stores.
        await validateActiveLease(supabase, connection, summary, deadlineMs)
        const result = await awaitDurableCommerceOperation(
          ingestTransactions(
            supabase,
            connection.company_id,
            connection.user_id,
            pageRows.rows,
            { settlementAccount: SHOPIFY_LEDGER_ACCOUNT, skipAutoCategorization: true },
          ),
          deadlineMs,
          'ingest Shopify transactions',
          'transaction_ingest',
          summary,
        )
        summary.imported += result.imported
        summary.duplicates += result.duplicates
        summary.errors += result.errors
        ingestHadErrors = result.errors > 0
      }

      if (page.hasNextPage && !page.endCursor) {
        throw new Error('Shopify returned hasNextPage without an endCursor')
      }
      cohortPassFoundNew = cohortPassFoundNew || workOrders.length > 0
      after = page.hasNextPage ? page.endCursor : null
      const completedOrderIds = ingestHadErrors
        ? []
        : workOrders
            .filter(order => !pageRows.incompleteOrderIds.has(order.legacyResourceId))
            .map(order => order.legacyResourceId)
      await checkpointShopifyScan(
        supabase,
        connection,
        durableState(),
        completedOrderIds,
        summary,
        deadlineMs,
      )

      if (ingestHadErrors) break
      if (pageRows.incompleteOrderIds.size > 0) {
        after = null
        cohortPassFoundNew = false
        await checkpointShopifyScan(
          supabase,
          connection,
          durableState(),
          [],
          summary,
          deadlineMs,
        )
        throw new CommerceSyncProviderError(
          'Shopify order or refund amount was malformed and remains pending',
          summary,
        )
      }

      if (!page.hasNextPage) {
        if (cohortPassFoundNew) {
          after = null
          cohortPassFoundNew = false
          await checkpointShopifyScan(
            supabase,
            connection,
            durableState(),
            [],
            summary,
            deadlineMs,
          )
        } else {
          const completedCohort = cohortUpdatedAt
          await completeShopifyCohort(
            supabase,
            connection,
            completedCohort,
            summary,
            deadlineMs,
          )
          scanMinUpdatedAt = completedCohort
          scanMinInclusive = false
          cohortUpdatedAt = null
          after = null
          cohortPassFoundNew = false
        }
      }

      // Apply the cap only after the end-of-cohort transition is durable. If
      // an exact cohort contains exactly MAX_ORDERS_PER_RUN rows, checking the
      // cap first would strand every no-new verification pass at its final
      // page and replay the same cohort forever.
      if (scannedThisRun >= MAX_ORDERS_PER_RUN) {
        log.warn('order cap reached; remaining orders resume next run', {
          connectionId: connection.id,
          cap: MAX_ORDERS_PER_RUN,
        })
        break
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err)) {
      // The app was deleted or its secret rotated in the Dev Dashboard: flip
      // the connection so the UI offers a reconnect instead of the cron
      // retrying forever.
      await revokeShopifyConnection(supabase, connection, summary, deadlineMs)
      summary.revoked = true
      log.warn('credentials revoked upstream; connection flipped to revoked', {
        connectionId: connection.id,
      })
      return summary
    }
    if (
      err instanceof CommerceSyncPersistenceError ||
      err instanceof CommerceSyncProviderError
    ) {
      throw err
    }
    throw new CommerceSyncProviderError(
      err instanceof Error ? err.message : String(err),
      summary,
      { cause: err },
    )
  }

  if (summary.skippedLocked > 0) {
    log.info('rows behind the bookkeeping lock were skipped', {
      connectionId: connection.id,
      skippedLocked: summary.skippedLocked,
    })
  }
  log.info('shopify order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
