import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'
import { syncMappedAccounts } from '@/lib/import/account-sync'
import { createLogger, type Logger } from '@/lib/logger'
import {
  CommerceSyncPersistenceError,
  CommerceSyncProviderError,
} from '@/lib/commerce/order-sync-errors'
import type { RawTransaction } from '@/types'
import {
  listOrdersPage,
  listOrderRefunds,
  isRevokedCredentialsError,
  WooCommerceDeadlineError,
  type WooCredentials,
  type WooCollectionPage,
} from './api-client'
import {
  awaitCommerceOperation,
  awaitDurableCommerceOperation,
  canonicalInstant,
  deadlineReached,
  sameInstant,
} from '@/lib/commerce/order-sync-runtime'
import { credentialsOf } from './connect'
import type { WooCommerceConnection, WooOrder, WooRefund } from '../types'

const defaultLog = createLogger('woocommerce/order-sync')

/**
 * WooCommerce order sync: the store's paid orders and refunds treated as a
 * bank-style feed.
 *
 * The store becomes a cash account on ledger 1680 (Andra kortfristiga
 * fordringar: money the payment gateways owe the merchant), and orders land
 * in the transactions inbox exactly like PSD2 bank rows: deduped on
 * external_id, bound to the cash account so booking settles against 1680, and
 * categorized/booked by the user through the normal flows. Nothing here
 * auto-books. 1686 (Fordringar för kontokort och kuponger) would be the
 * closest BAS account but is owned by the Stripe feed, and cash_accounts
 * enforces one account per ledger per company.
 *
 * Row model: a paid order produces one positive row for its gross total; each
 * refund produces one negative row. Payment-processor fees never appear:
 * core wc/v3 does not expose them (they belong to the gateway, e.g. the
 * Stripe feed for Stripe-gateway stores). order.transaction_id rides along as
 * the row reference for later gateway-side reconciliation.
 *
 * Pagination is CURSOR-based, not offset-based: each request asks for the
 * oldest orders with date_modified strictly after the current cursor
 * (orderby=modified asc, page=1), and the cursor advances to the last row of
 * each processed page. Offset pages over a fixed window would silently skip
 * rows whenever an already-fetched order is modified mid-run (it re-sorts to
 * the end and shifts every later row one index down); with a moving cursor a
 * mid-run modification simply re-surfaces the order later in the same run.
 * A page tail can contain only a prefix of one date_modified second because
 * modified_after is strictly exclusive. Every tail therefore becomes an
 * exact-second, ID-ordered cohort. Durable completion markers and repeated
 * page-one-to-empty passes allow offset progress to survive caps and
 * deadlines; the cursor crosses the second only after one full pass finds no
 * unseen provider ID. Provider row movement can cause replay, never a skip.
 *
 * Cursor: woocommerce_connections.last_order_synced_at, re-polled with a 24h
 * overlap. Each complete page advances to its last date_modified, and a
 * successfully exhausted window advances to the run start as a scanned-through
 * watermark so quiet stores rotate behind older cursors. It never advances
 * past failed work: a page with refund-fetch failures, ingest errors, or
 * deadline-skipped refunds caps the persisted cursor just below the earliest
 * affected order's date_modified, so the next run re-lists exactly the orders
 * whose rows are incomplete (re-seen complete rows collide on (company_id,
 * external_id) and are skipped). First run fetches BACKFILL_DAYS back.
 *
 * Lock-date guard: modified_after selects on date_modified, but rows are
 * dated by date_paid / refund date_created, which can be arbitrarily older
 * (a refund or edit bumps date_modified long after payment). Rows dated on or
 * before company_settings.bookkeeping_locked_through are therefore dropped at
 * map time on EVERY run: the enforce_company_lock_date trigger makes them
 * permanently unbookable, and feed rows are undeletable by design, so
 * importing them would create permanent inbox noise. Dropped rows are counted
 * in skipped_locked and logged.
 */

/** BAS ledger account for the WooCommerce store cash account. */
export const WOOCOMMERCE_LEDGER_ACCOUNT = '1680'
/** BAS 2026 name for 1680; used when creating the chart account. */
const WOOCOMMERCE_LEDGER_ACCOUNT_NAME = 'Andra kortfristiga fordringar'
/** transactions.import_source for WooCommerce feed rows. */
export const WOOCOMMERCE_IMPORT_SOURCE = 'woocommerce'
/** First-run backfill window (matches the Enable Banking convention). */
export const BACKFILL_DAYS = 90
/** Cursor re-poll overlap; external_id dedup makes duplicates no-ops. */
const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000
/**
 * Safety cap on orders per run (matches the Stripe feed's MAX_TXNS_PER_RUN).
 * The real bound is the caller's deadline; hitting this cap is logged loudly
 * because a silent cap reads as "covered everything" when it did not. The
 * cursor resumes where a truncated run stopped.
 */
const MAX_ORDERS_PER_RUN = 10_000

/**
 * ⚠️ STORED-KEY FORMATS. These are persisted to transactions.external_id and
 * dedup compares stored ids byte-for-byte, exactly like the Stripe and Enable
 * Banking schemes. Changing a template silently orphans every prior row and
 * re-imports the whole feed on the next sync. Locked by the frozen-format
 * test in order-sync.test.ts; any change MUST ship a coordinated backfill.
 *
 * The scope is the store's normalized host(+path), NOT the connection id, so
 * a disconnect/reconnect of the same store keeps every previously imported
 * row deduped.
 */
export function wooStoreScope(storeUrl: string): string {
  return storeUrl.replace(/^https:\/\//, '')
}

export function wooOrderExternalId(storeScope: string, orderId: number): string {
  return `woo_${storeScope}_order_${orderId}`
}

export function wooRefundExternalId(storeScope: string, refundId: number): string {
  return `woo_${storeScope}_refund_${refundId}`
}

export interface WooCommerceSyncSummary {
  /** Orders listed from the store (all statuses in the window). */
  fetched: number
  /** Refund objects fetched for refunded orders in the window. */
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

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Money fields arrive as strings; unparseable input returns null so callers
 * can tell a corrupt total (counted + logged in buildPageRows) from a
 * legitimate zero (silently skipped).
 */
function parseAmount(value: string): number | null {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? round(parsed) : null
}

/** Whether a qualifying order's total cannot be read as money. */
export function orderAmountUnparseable(order: Pick<WooOrder, 'total'>): boolean {
  return parseAmount(order.total) === null
}

/** Date part of a wc/v3 _gmt timestamp ("2026-08-01T12:34:56", no zone suffix). */
function isoDateOfGmt(timestamp: string): string {
  return timestamp.split('T')[0]
}

/** wc/v3 _gmt timestamps lack a zone suffix; brand them UTC for timestamptz. */
function gmtToIso(timestamp: string): string {
  return timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`
}

function gmtToMs(timestamp: string): number {
  return Date.parse(gmtToIso(timestamp))
}

/**
 * Whether an order belongs in the feed: it must have been paid (date_paid is
 * the revenue signal; pending/failed/cancelled-before-payment orders never
 * carry one) and not be trashed. Status 'refunded' stays IN: a fully refunded
 * order was still paid, and its refunds land as separate negative rows so the
 * pair nets to zero instead of the gross silently disappearing.
 */
export function orderQualifies(order: Pick<WooOrder, 'status' | 'date_paid_gmt'>): boolean {
  return Boolean(order.date_paid_gmt) && order.status !== 'trash'
}

/**
 * Map a paid order to its gross feed row. Dates use date_paid (when the money
 * event happened), not date_created: booked entries, invoice matching, and
 * month boundaries all want the payment date. Descriptions are deterministic
 * from immutable data (order numbers never change) because the content-dedup
 * bridge keys off them.
 */
export function mapOrder(storeScope: string, order: WooOrder): RawTransaction[] {
  if (!orderQualifies(order)) return []
  const amount = parseAmount(order.total)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOfGmt(order.date_paid_gmt!),
      description: `WooCommerce-order #${order.number}`,
      amount,
      currency: order.currency.toUpperCase(),
      external_id: wooOrderExternalId(storeScope, order.id),
      import_source: WOOCOMMERCE_IMPORT_SOURCE,
      reference: order.transaction_id || null,
    },
  ]
}

/** Map one refund of a paid order to its negative feed row. */
export function mapRefund(
  storeScope: string,
  order: Pick<WooOrder, 'number' | 'currency'>,
  refund: WooRefund,
): RawTransaction[] {
  const amount = parseAmount(refund.amount)
  if (amount === null || amount === 0) return []
  return [
    {
      date: isoDateOfGmt(refund.date_created_gmt),
      description: `WooCommerce-återbetalning order #${order.number}`,
      amount: -amount,
      currency: order.currency.toUpperCase(),
      external_id: wooRefundExternalId(storeScope, refund.id),
      import_source: WOOCOMMERCE_IMPORT_SOURCE,
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
    'fetch WooCommerce bookkeeping lock',
  )
  if (error) {
    throw new Error(`Failed to fetch company lock date: ${error.message}`)
  }
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
 * Window start (ISO, UTC) for the first modified_after list call. With a
 * cursor: cursor minus the 24h overlap. First run: BACKFILL_DAYS back. (The
 * lock date no longer floors the window: it selects on date_modified while
 * rows are dated by date_paid, so the real guard is rowBehindLock at map
 * time, applied on every run.)
 */
function resolveWindowStartIso(
  connection: WooCommerceConnection,
  runStartMs: number,
): string {
  if (
    connection.last_order_synced_at &&
    Date.parse(connection.last_order_synced_at) <= runStartMs
  ) {
    const cursorMs = Date.parse(connection.last_order_synced_at)
    return new Date(Math.max(0, cursorMs - CURSOR_OVERLAP_MS)).toISOString()
  }
  return new Date(runStartMs - BACKFILL_DAYS * 86_400_000).toISOString()
}

function secondBefore(iso: string): string {
  return new Date(Date.parse(iso) - 1000).toISOString()
}

function secondAfter(iso: string): string {
  return new Date(Date.parse(iso) + 1000).toISOString()
}

async function persistConnectionProgress(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  values: Record<string, unknown>,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase
    .from('woocommerce_connections')
    .update(values)
    .eq('id', connection.id)
    .eq('status', 'active')
    .eq('order_sync_claim_token', requireClaimToken(connection))
    .gt('order_sync_claimed_until', new Date().toISOString())
    .select('id')
    .maybeSingle()
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'persist WooCommerce progress',
    'progress_checkpoint',
    summary,
  )
  if (error) {
    throw new CommerceSyncPersistenceError(
      `Failed to persist WooCommerce order progress: ${error.message}`,
      'progress_checkpoint',
      summary,
    )
  }
  if (!data) {
    throw new CommerceSyncPersistenceError(
      `Failed to persist WooCommerce order progress for ${connection.id}`,
      'progress_checkpoint',
      summary,
    )
  }
}

function requireClaimToken(connection: WooCommerceConnection): string {
  if (!connection.order_sync_claim_token) {
    throw new CommerceSyncPersistenceError(
      'WooCommerce sync has no exact claim token',
      'lease_validation',
    )
  }
  return connection.order_sync_claim_token
}

async function validateActiveLease(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase
    .from('woocommerce_connections')
    .select('id')
    .eq('id', connection.id)
    .eq('status', 'active')
    .eq('order_sync_claim_token', requireClaimToken(connection))
    .gt('order_sync_claimed_until', new Date().toISOString())
    .maybeSingle()
  const { data, error } = await awaitCommerceOperation(
    query,
    deadlineMs,
    'validate WooCommerce sync lease',
  )
  if (error || !data) {
    throw new CommerceSyncPersistenceError(
      `WooCommerce sync lease is no longer active${error ? `: ${error.message}` : ''}`,
      'lease_validation',
      summary,
    )
  }
}

async function fetchSeenOrderIds(
  supabase: SupabaseClient,
  connectionId: string,
  modifiedAt: string,
  orderIds: number[],
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<Set<number>> {
  if (orderIds.length === 0) return new Set()
  const query = supabase
    .from('woocommerce_order_sync_seen')
    .select('order_id')
    .eq('connection_id', connectionId)
    .eq('modified_at', modifiedAt)
    .in('order_id', orderIds)
  const { data, error } = await awaitCommerceOperation(
    query,
    deadlineMs,
    'read WooCommerce cohort markers',
  )
  if (error) {
    throw new CommerceSyncPersistenceError(
      `Failed to read WooCommerce cohort progress: ${error.message}`,
      'cohort_read',
      summary,
    )
  }
  return new Set((data ?? []).map(row => Number((row as { order_id: number }).order_id)))
}

async function startSeenCohort(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  modifiedAt: string,
  scanModifiedAfter: string,
  orderIds: number[],
  cursorIso: string | null,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('start_woocommerce_order_sync_cohort', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_scan_modified_after: scanModifiedAfter,
    p_modified_at: modifiedAt,
    p_order_ids: orderIds,
    p_last_order_synced_at: cursorIso,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'start WooCommerce cohort',
    'cohort_start',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to start WooCommerce cohort${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
      'cohort_start',
      summary,
    )
  }
}

async function checkpointSeenCohort(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  state: {
    scanModifiedAfter: string
    modifiedAt: string
    page: number
    passFoundNew: boolean
    expectedTotal: number | null
    expectedPages: number | null
    passSeenCount: number
    passLastOrderId: number | null
  },
  completedOrderIds: number[],
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('checkpoint_woocommerce_order_sync', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_scan_modified_after: state.scanModifiedAfter,
    p_modified_at: state.modifiedAt,
    p_page: state.page,
    p_pass_found_new: state.passFoundNew,
    p_expected_total: state.expectedTotal,
    p_expected_pages: state.expectedPages,
    p_pass_seen_count: state.passSeenCount,
    p_pass_last_order_id: state.passLastOrderId,
    p_completed_order_ids: completedOrderIds,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'checkpoint WooCommerce cohort',
    'cohort_checkpoint',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to checkpoint WooCommerce cohort${error ? `: ${error.message}` : ': exact active lease and cohort were not matched'}`,
      'cohort_checkpoint',
      summary,
    )
  }
}

async function completeWooScan(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  watermark: string,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('complete_woocommerce_order_sync', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_last_order_synced_at: watermark,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'complete WooCommerce scan',
    'scan_completion',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to complete WooCommerce scan${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
      'scan_completion',
      summary,
    )
  }
}

async function completeSeenCohort(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  modifiedAt: string,
  cursorIso: string | null,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const query = supabase.rpc('complete_woocommerce_order_sync_cohort', {
    p_connection_id: connection.id,
    p_claim_token: requireClaimToken(connection),
    p_modified_at: modifiedAt,
    p_last_order_synced_at: cursorIso,
  })
  const { data, error } = await awaitDurableCommerceOperation(
    query,
    deadlineMs,
    'complete WooCommerce cohort',
    'cohort_completion',
    summary,
  )
  if (error || data !== true) {
    throw new CommerceSyncPersistenceError(
      `Failed to complete WooCommerce cohort${error ? `: ${error.message}` : ': exact active lease and cohort were not matched'}`,
      'cohort_completion',
      summary,
    )
  }
}

/**
 * Make sure the store cash account exists (ledger 1680, source manual so a
 * later remap/promotion follows the normal cash-account rules) and, on the
 * first run, that 1680 exists in the chart of accounts: the booking dialog
 * and AccountPicker only list chart accounts.
 *
 * Currency comes from the store settings read at connect time, falling back
 * to the first fetched order's real currency (settings/general is blocked on
 * some hardened stores, and guessing SEK for an EUR store would poison the
 * account). A conflict with an existing 1680 cash account throws; the caller
 * surfaces that on the connection so the panel shows why nothing syncs.
 */
async function ensureStoreAccount(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  fallbackCurrency: string | undefined,
  firstRun: boolean,
  log: Logger,
  summary: WooCommerceSyncSummary,
  deadlineMs?: number,
): Promise<void> {
  const currency =
    connection.currency?.toUpperCase() || fallbackCurrency?.toUpperCase() || 'SEK'
  try {
    await ensureManualCashAccount(
      supabase,
      connection.company_id,
      WOOCOMMERCE_LEDGER_ACCOUNT,
      currency,
      'WooCommerce-saldo',
    )
  } catch (accountError) {
    // Typically a currency conflict with an existing 1680 cash account. Made
    // visible on the connection: without this the panel shows a healthy
    // "Ansluten" store that silently never syncs.
    await persistConnectionProgress(
      supabase,
      connection,
      {
        error_message:
          'Kassakontot för butiken (1680) kunde inte skapas. Kontrollera att befintligt konto 1680 har samma valuta som butiken.',
      },
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
          sourceAccount: WOOCOMMERCE_LEDGER_ACCOUNT,
          sourceName: WOOCOMMERCE_LEDGER_ACCOUNT_NAME,
          targetAccount: WOOCOMMERCE_LEDGER_ACCOUNT,
          targetName: WOOCOMMERCE_LEDGER_ACCOUNT_NAME,
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
      log.warn('chart sync for 1680 failed', {
        companyId: connection.company_id,
        error: sync.error,
      })
    }
  }
}

interface PageRowsOutcome {
  rows: RawTransaction[]
  /**
   * date_modified (ms) of every order whose refund rows are incomplete this
   * run (fetch failed or skipped on deadline). The cursor must not advance
   * past these: the next run has to re-list them.
   */
  incompleteModifiedMs: number[]
  incompleteOrderIds: number[]
  malformedOrderIds: number[]
  hitDeadline: boolean
}

/** Rows for one page of orders: gross rows plus refund rows where present. */
async function buildPageRows(
  creds: WooCredentials,
  storeScope: string,
  orders: WooOrder[],
  lockThrough: string | null,
  summary: WooCommerceSyncSummary,
  log: Logger,
  deadlineMs?: number,
): Promise<PageRowsOutcome> {
  const outcome: PageRowsOutcome = {
    rows: [],
    incompleteModifiedMs: [],
    incompleteOrderIds: [],
    malformedOrderIds: [],
    hitDeadline: false,
  }

  const push = (mapped: RawTransaction[]) => {
    for (const row of mapped) {
      if (rowBehindLock(row.date, lockThrough)) {
        summary.skippedLocked += 1
        continue
      }
      outcome.rows.push(row)
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
        orderId: order.id,
        total: order.total,
      })
      outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
      outcome.incompleteOrderIds.push(order.id)
      outcome.malformedOrderIds.push(order.id)
    }
    push(mapOrder(storeScope, order))
    // Refunds only exist for qualifying (paid) orders: a refund row without
    // its gross counterpart would be an unexplainable negative in the inbox.
    if (!orderQualifies(order) || order.refunds.length === 0) continue

    // Refund fetches are one request per refunded order against a slow host;
    // without this check a single mass-refund page could blow through the
    // function's maxDuration and the cursor would never persist.
    if (outcome.hitDeadline || (deadlineMs !== undefined && Date.now() >= deadlineMs)) {
      outcome.hitDeadline = true
      outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
      outcome.incompleteOrderIds.push(order.id)
      continue
    }

    try {
      const refunds = await listOrderRefunds(creds, order.id, {
        startDeadlineMs: deadlineMs,
      })
      summary.refundsFetched += refunds.length
      for (const refund of refunds) {
        if (parseAmount(refund.amount) === null) {
          summary.errors += 1
          log.warn('unparseable refund amount; row skipped', {
            orderId: order.id,
            refundId: refund.id,
            amount: refund.amount,
          })
          outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
          outcome.incompleteOrderIds.push(order.id)
          outcome.malformedOrderIds.push(order.id)
        }
        push(mapRefund(storeScope, order, refund))
      }
    } catch (refundError) {
      if (isRevokedCredentialsError(refundError)) throw refundError
      if (refundError instanceof WooCommerceDeadlineError) {
        outcome.hitDeadline = true
        outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
        outcome.incompleteOrderIds.push(order.id)
        continue
      }
      // The order row still imports; the cursor is capped below this order's
      // date_modified so the next run re-lists it and retries the refunds.
      summary.errors += 1
      outcome.incompleteModifiedMs.push(gmtToMs(order.date_modified_gmt))
      outcome.incompleteOrderIds.push(order.id)
      log.warn('refund fetch failed; order held for retry next run', {
        orderId: order.id,
        message: refundError instanceof Error ? refundError.message : String(refundError),
      })
    }
  }
  return outcome
}

export async function syncWooCommerceOrders(
  supabase: SupabaseClient,
  connection: WooCommerceConnection,
  log: Logger = defaultLog,
  /**
   * Absolute deadline (epoch ms) from the caller's time budget. Enforced
   * between pages AND between refund fetches inside a page: the cursor
   * advances only over fully-processed work, so the next run resumes exactly
   * where this one stopped.
   */
  deadlineMs?: number,
): Promise<WooCommerceSyncSummary> {
  const summary: WooCommerceSyncSummary = {
    fetched: 0,
    refundsFetched: 0,
    imported: 0,
    duplicates: 0,
    skippedLocked: 0,
    errors: 0,
  }
  if (
    connection.status !== 'active' ||
    !connection.consumer_key_encrypted ||
    !connection.consumer_secret_encrypted
  ) {
    return summary
  }

  if (deadlineReached(deadlineMs)) {
    summary.deadlineReached = true
    return summary
  }

  const runStartMs = Date.now()
  const claimToken = requireClaimToken(connection)
  const creds = credentialsOf(connection)
  const storeScope = wooStoreScope(connection.store_url)
  const firstRun = !connection.last_order_synced_at
  const lockThrough = await fetchLockThrough(supabase, connection.company_id, deadlineMs)

  const storedCursorMs = connection.last_order_synced_at
    ? Date.parse(canonicalInstant(connection.last_order_synced_at, 'WooCommerce cursor'))
    : 0
  const recoveringFutureCursor = storedCursorMs > runStartMs
  let modifiedAfter = connection.order_sync_scan_modified_after
    ? canonicalInstant(connection.order_sync_scan_modified_after, 'WooCommerce scan lower bound')
    : resolveWindowStartIso(connection, runStartMs)
  let prevCursorMs = recoveringFutureCursor ? 0 : storedCursorMs
  let cohortModifiedAt = connection.order_sync_cohort_modified_at
    ? canonicalInstant(connection.order_sync_cohort_modified_at, 'WooCommerce cohort')
    : null
  let cohortPage = connection.order_sync_cohort_page ?? 1
  let cohortPassFoundNew = connection.order_sync_cohort_pass_found_new ?? false
  let cohortExpectedTotal = connection.order_sync_cohort_expected_total ?? null
  let cohortExpectedPages = connection.order_sync_cohort_expected_pages ?? null
  let cohortPassSeenCount = connection.order_sync_cohort_pass_seen_count ?? 0
  let cohortPassLastOrderId = connection.order_sync_cohort_pass_last_order_id ?? null
  // Earliest incomplete work this run; the persisted cursor never passes it.
  let failureFloorMs = Number.POSITIVE_INFINITY
  // True only after a successful empty response proves the list is exhausted.
  let windowExhausted = false
  let accountEnsured = false

  try {
    if (!connection.order_sync_scan_modified_after) {
      await persistConnectionProgress(
        supabase,
        connection,
        { order_sync_scan_modified_after: modifiedAfter },
        summary,
        deadlineMs,
      )
    }
    for (;;) {
      if (deadlineReached(deadlineMs)) {
        summary.deadlineReached = true
        log.info('time budget exhausted; stopping order sync', {
          connectionId: connection.id,
          processed: summary.imported + summary.duplicates,
        })
        break
      }

      const inCohort = cohortModifiedAt !== null
      const collection: WooCollectionPage<WooOrder> = await listOrdersPage(
        creds,
        inCohort
          ? {
              modifiedAfter: secondBefore(cohortModifiedAt!),
              modifiedBefore: secondAfter(cohortModifiedAt!),
              orderBy: 'id',
              page: cohortPage,
            }
          : { modifiedAfter, orderBy: 'modified', page: 1 },
        { startDeadlineMs: deadlineMs },
      )
      if (deadlineReached(deadlineMs)) {
        summary.deadlineReached = true
        break
      }
      const orders = collection.items
      if (collection.total === 0) {
        if (collection.totalPages !== 0 || orders.length !== 0) {
          throw new Error('WooCommerce returned inconsistent empty collection metadata')
        }
        if (inCohort) {
          if (cohortExpectedTotal !== null && cohortExpectedTotal !== 0) {
            cohortPage = 1
            cohortPassFoundNew = false
            cohortExpectedTotal = null
            cohortExpectedPages = null
            cohortPassSeenCount = 0
            cohortPassLastOrderId = null
            await checkpointSeenCohort(
              supabase,
              connection,
              {
                scanModifiedAfter: modifiedAfter,
                modifiedAt: cohortModifiedAt!,
                page: 1,
                passFoundNew: false,
                expectedTotal: null,
                expectedPages: null,
                passSeenCount: 0,
                passLastOrderId: null,
              },
              [],
              summary,
              deadlineMs,
            )
            continue
          }
          const completedCohortMs = Date.parse(cohortModifiedAt!)
          const candidateMs = Math.min(completedCohortMs, failureFloorMs)
          const completedCursorIso = candidateMs > prevCursorMs
            ? new Date(candidateMs).toISOString()
            : null
          await completeSeenCohort(
            supabase,
            connection,
            cohortModifiedAt!,
            completedCursorIso,
            summary,
            deadlineMs,
          )
          if (candidateMs > prevCursorMs) {
            connection.last_order_synced_at = new Date(candidateMs).toISOString()
            prevCursorMs = candidateMs
          }
          modifiedAfter = cohortModifiedAt!
          cohortModifiedAt = null
          cohortPage = 1
          cohortPassFoundNew = false
          cohortExpectedTotal = null
          cohortExpectedPages = null
          cohortPassSeenCount = 0
          cohortPassLastOrderId = null
          continue
        }
        windowExhausted = true
        break
      }
      if (collection.totalPages < 1 || collection.page > collection.totalPages) {
        throw new Error('WooCommerce returned invalid collection pagination metadata')
      }
      summary.fetched += orders.length

      const cohortOrders = orders
      if (inCohort) {
        if (collection.total > 100_000) {
          throw new Error('WooCommerce cohort exceeds the 100000 marker bound')
        }
        if (cohortExpectedTotal === null) {
          cohortExpectedTotal = collection.total
          cohortExpectedPages = collection.totalPages
        } else if (
          collection.total !== cohortExpectedTotal
          || collection.totalPages !== cohortExpectedPages
        ) {
          cohortPage = 1
          cohortPassFoundNew = false
          cohortExpectedTotal = null
          cohortExpectedPages = null
          cohortPassSeenCount = 0
          cohortPassLastOrderId = null
          await checkpointSeenCohort(
            supabase,
            connection,
            {
              scanModifiedAfter: modifiedAfter,
              modifiedAt: cohortModifiedAt!,
              page: cohortPage,
              passFoundNew: false,
              expectedTotal: null,
              expectedPages: null,
              passSeenCount: 0,
              passLastOrderId: null,
            },
            [],
            summary,
            deadlineMs,
          )
          continue
        }
        if (cohortPage !== collection.page || cohortExpectedPages === null) {
          throw new Error('WooCommerce ignored the requested cohort page')
        }
        if (orders.length === 0) {
          throw new Error('WooCommerce ended a cohort before its advertised final page')
        }
        for (const order of orders) {
          if (!sameInstant(gmtToIso(order.date_modified_gmt), cohortModifiedAt!)) {
            throw new Error('WooCommerce exact-cohort query returned a different modified time')
          }
          if (cohortPassLastOrderId !== null && order.id <= cohortPassLastOrderId) {
            throw new Error('WooCommerce cohort page repeated or was not ID-monotonic')
          }
          cohortPassLastOrderId = order.id
        }
      }
      const seenOrderIds = inCohort
        ? await fetchSeenOrderIds(
            supabase,
            connection.id,
            cohortModifiedAt!,
            cohortOrders.map(order => order.id),
            summary,
            deadlineMs,
          )
        : new Set<number>()
      const workOrders = cohortOrders.filter(order => !seenOrderIds.has(order.id))

      // Deferred until the window is known non-empty so a quiet store creates
      // no cash-account or chart state; successful exhaustion only updates its
      // cursor. The first order also provides a real currency fallback when
      // store settings were unreadable.
      if (!accountEnsured && workOrders.length > 0) {
        await awaitDurableCommerceOperation(
          ensureStoreAccount(
            supabase,
            connection,
            workOrders[0].currency,
            firstRun,
            log,
            summary,
            deadlineMs,
          ),
          deadlineMs,
          'ensure WooCommerce store account',
          'store_account_setup',
          summary,
        )
        accountEnsured = true
      }

      const page = await buildPageRows(
        creds,
        storeScope,
        workOrders,
        lockThrough,
        summary,
        log,
        deadlineMs,
      )
      if (page.hitDeadline) summary.deadlineReached = true

      const firstMs = workOrders.length > 0
        ? gmtToMs(workOrders[0].date_modified_gmt)
        : Number.POSITIVE_INFINITY
      const lastMs = gmtToMs(orders[orders.length - 1].date_modified_gmt)
      let ingestHadErrors = false

      if (page.rows.length > 0) {
        // Auto-categorization is skipped on purpose: booking WooCommerce
        // money is a human decision in the inbox (feed-only doctrine, same
        // as the Stripe feed). Invoice matching still runs (suggestions
        // only), and FX enrichment covers non-SEK stores.
        await validateActiveLease(supabase, connection, summary, deadlineMs)
        const result = await awaitDurableCommerceOperation(
          ingestTransactions(
            supabase,
            connection.company_id,
            connection.user_id,
            page.rows,
            { settlementAccount: WOOCOMMERCE_LEDGER_ACCOUNT, skipAutoCategorization: true },
          ),
          deadlineMs,
          'ingest WooCommerce transactions',
          'transaction_ingest',
          summary,
        )
        summary.imported += result.imported
        summary.duplicates += result.duplicates
        summary.errors += result.errors
        if (result.errors > 0) {
          ingestHadErrors = true
          // Failed inserts are dropped inside ingest; hold the cursor below
          // this page so the next run re-lists and retries it rather than
          // turning a transient DB error into permanently missing rows.
          failureFloorMs = Math.min(failureFloorMs, firstMs - 1000)
        }
      }
      for (const ms of page.incompleteModifiedMs) {
        failureFloorMs = Math.min(failureFloorMs, ms - 1000)
      }

      const incompleteOrderIds = new Set(page.incompleteOrderIds)
      const completedOrderIds = ingestHadErrors
        ? []
        : workOrders
            .filter(order => !incompleteOrderIds.has(order.id))
            .map(order => order.id)

      if (inCohort) {
        cohortPassFoundNew = cohortPassFoundNew || workOrders.length > 0
        cohortPassSeenCount += cohortOrders.length
        const incomplete = ingestHadErrors || incompleteOrderIds.size > 0
        const malformed = page.malformedOrderIds.length > 0
        if (incomplete) {
          await checkpointSeenCohort(
            supabase,
            connection,
            {
              scanModifiedAfter: modifiedAfter,
              modifiedAt: cohortModifiedAt!,
              page: 1,
              passFoundNew: false,
              expectedTotal: null,
              expectedPages: null,
              passSeenCount: 0,
              passLastOrderId: null,
            },
            completedOrderIds,
            summary,
            deadlineMs,
          )
          if (malformed) {
            throw new CommerceSyncProviderError(
              'WooCommerce order or refund amount was malformed and remains pending',
              summary,
            )
          }
          break
        }

        const finalPage = cohortPage === cohortExpectedPages
        if (finalPage && cohortPassSeenCount !== cohortExpectedTotal) {
          throw new Error('WooCommerce cohort page totals did not match collection metadata')
        }
        if (!finalPage) {
          cohortPage += 1
          await checkpointSeenCohort(
            supabase,
            connection,
            {
              scanModifiedAfter: modifiedAfter,
              modifiedAt: cohortModifiedAt!,
              page: cohortPage,
              passFoundNew: cohortPassFoundNew,
              expectedTotal: cohortExpectedTotal,
              expectedPages: cohortExpectedPages,
              passSeenCount: cohortPassSeenCount,
              passLastOrderId: cohortPassLastOrderId,
            },
            completedOrderIds,
            summary,
            deadlineMs,
          )
        } else if (cohortPassFoundNew) {
          cohortPage = 1
          cohortPassFoundNew = false
          cohortExpectedTotal = null
          cohortExpectedPages = null
          cohortPassSeenCount = 0
          cohortPassLastOrderId = null
          await checkpointSeenCohort(
            supabase,
            connection,
            {
              scanModifiedAfter: modifiedAfter,
              modifiedAt: cohortModifiedAt!,
              page: 1,
              passFoundNew: false,
              expectedTotal: null,
              expectedPages: null,
              passSeenCount: 0,
              passLastOrderId: null,
            },
            completedOrderIds,
            summary,
            deadlineMs,
          )
        } else {
          const completedCohortMs = Date.parse(cohortModifiedAt!)
          const candidateMs = Math.min(completedCohortMs, failureFloorMs)
          const completedCursorIso = candidateMs > prevCursorMs
            ? new Date(candidateMs).toISOString()
            : null
          await completeSeenCohort(
            supabase,
            connection,
            cohortModifiedAt!,
            completedCursorIso,
            summary,
            deadlineMs,
          )
          if (candidateMs > prevCursorMs) {
            connection.last_order_synced_at = new Date(candidateMs).toISOString()
            prevCursorMs = candidateMs
          }
          modifiedAfter = cohortModifiedAt!
          cohortModifiedAt = null
          cohortPage = 1
          cohortPassFoundNew = false
          cohortExpectedTotal = null
          cohortExpectedPages = null
          cohortPassSeenCount = 0
          cohortPassLastOrderId = null
        }
      } else {
        const movingPageIncomplete = ingestHadErrors || incompleteOrderIds.size > 0
        if (movingPageIncomplete) {
          // A failure floor exists only in this invocation. Persisting a later
          // tail cohort would let a restart complete that cohort and forget
          // the earlier failure. Save only monotonic progress below the
          // earliest incomplete order, write no tail markers, and stop so the
          // next invocation re-lists from the provider cursor plus overlap.
          const candidateMs = Math.min(lastMs - 1000, failureFloorMs)
          if (candidateMs > prevCursorMs) {
            const cursorIso = new Date(candidateMs).toISOString()
            await persistConnectionProgress(
              supabase,
              connection,
              { last_order_synced_at: cursorIso, error_message: null },
              summary,
              deadlineMs,
            )
            connection.last_order_synced_at = cursorIso
            prevCursorMs = candidateMs
          }
          if (page.malformedOrderIds.length > 0) {
            throw new CommerceSyncProviderError(
              'WooCommerce order or refund amount was malformed and remains pending',
              summary,
            )
          }
          break
        }

        // Every moving page enters an exact-second cohort at its mixed tail.
        // A short page is not proof of completion because hosts can lower
        // per_page. Only the subsequent no-new verification pass may cross T.
        const tailModifiedAt = new Date(lastMs).toISOString()
        const tailOrderIds = completedOrderIds.filter(orderId =>
          workOrders.some(
            order => order.id === orderId && gmtToMs(order.date_modified_gmt) === lastMs,
          ),
        )
        const candidateMs = Math.min(lastMs - 1000, failureFloorMs)
        const cursorIso = candidateMs > prevCursorMs
          ? new Date(candidateMs).toISOString()
          : null
        await startSeenCohort(
          supabase,
          connection,
          tailModifiedAt,
          modifiedAfter,
          tailOrderIds,
          cursorIso,
          summary,
          deadlineMs,
        )
        cohortModifiedAt = tailModifiedAt
        cohortPage = 1
        cohortPassFoundNew = false
        cohortExpectedTotal = null
        cohortExpectedPages = null
        cohortPassSeenCount = 0
        cohortPassLastOrderId = null
        if (candidateMs > prevCursorMs) {
          connection.last_order_synced_at = cursorIso
          prevCursorMs = candidateMs
        }
      }

      if (summary.deadlineReached) break

      if (summary.fetched >= MAX_ORDERS_PER_RUN) {
        log.warn('order cap reached; remaining orders resume next run', {
          connectionId: connection.id,
          cap: MAX_ORDERS_PER_RUN,
        })
        break
      }
    }

    // A successful empty page proves the moving WooCommerce window was fully
    // scanned. Advancing to the run start rotates quiet stores in the cron;
    // the 24h overlap still re-polls updates that landed during the run. Do
    // not apply this watermark after any incomplete refund or ingest work.
    if (windowExhausted && failureFloorMs === Number.POSITIVE_INFINITY) {
      const watermarkMs = runStartMs
      if (watermarkMs > prevCursorMs) {
        const cursorIso = new Date(watermarkMs).toISOString()
        await completeWooScan(supabase, connection, cursorIso, summary, deadlineMs)
        connection.last_order_synced_at = cursorIso
        prevCursorMs = watermarkMs
      }
    }
  } catch (err) {
    if (isRevokedCredentialsError(err)) {
      // The key was deleted or demoted in wp-admin: flip the connection so
      // the UI offers a reconnect instead of the cron retrying forever.
      const query = supabase.rpc('revoke_commerce_connection_for_sync', {
        p_provider: 'woocommerce',
        p_connection_id: connection.id,
        p_claim_token: claimToken,
        p_error_message: 'Butiken avvisade API-nyckeln. Anslut butiken igen.',
        p_disconnected_at: new Date().toISOString(),
      })
      const { data, error } = await awaitDurableCommerceOperation(
        query,
        deadlineMs,
        'persist WooCommerce credential revocation',
        'credential_revocation',
        summary,
      )
      if (error || data !== true) {
        throw new CommerceSyncPersistenceError(
          `Failed to persist WooCommerce credential revocation${error ? `: ${error.message}` : ': exact active lease was not matched'}`,
          'credential_revocation',
          summary,
        )
      }
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
  log.info('woocommerce order sync done', {
    connectionId: connection.id,
    ...summary,
  })
  return summary
}
