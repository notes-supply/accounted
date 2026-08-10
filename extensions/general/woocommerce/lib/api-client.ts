import { isIP } from 'node:net'
import {
  pinnedHttpsFetch,
  type PinnedFetchDeps,
  type PinnedFetchResult,
} from '@/lib/webhooks/pinned-fetch'
import type { WooOrder, WooRefund, WooStoreInfo } from '../types'

/**
 * Minimal WooCommerce REST API (wc/v3) client for the order feed.
 *
 * Auth is HTTP Basic (consumer key as username, secret as password) over
 * HTTPS only. Rejected credentials are terminal and are never retried in the
 * query string: that would duplicate a non-transient request and expose keys
 * to URL-oriented logs and middleware.
 *
 * Typical WooCommerce hosts are slow shared PHP boxes: requests run
 * sequentially, pages are capped at 100 rows, and 429/5xx responses get a
 * short exponential backoff before the error is surfaced.
 */

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [1_000, 3_000]
/** wc/v3 hard maximum for per_page. */
export const WC_PAGE_SIZE = 100

export interface WooCredentials {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
}

export interface WooApiClientDeps extends PinnedFetchDeps {
  pinnedFetch?: typeof pinnedHttpsFetch
  sleep?: (ms: number) => Promise<void>
  requestTimeoutMs?: number
  maxResponseBytes?: number
}

export class WooCommerceApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network-level failures. */
    readonly status: number,
    /** WooCommerce error code (e.g. woocommerce_rest_cannot_view), if any. */
    readonly wooCode: string | null = null,
    /** Whether the existing backoff loop may safely retry this failure. */
    readonly retryable = status === 0,
  ) {
    super(message)
    this.name = 'WooCommerceApiError'
  }
}

/**
 * Whether an API error means the credentials themselves are dead (key deleted
 * or demoted in wp-admin), as opposed to a transient failure. Used to flip a
 * connection to status 'revoked' so the UI offers a reconnect instead of the
 * cron retrying forever.
 */
export function isRevokedCredentialsError(error: unknown): boolean {
  if (!(error instanceof WooCommerceApiError)) return false
  return error.status === 401 || error.status === 403
}

/**
 * Hostnames the server must never fetch: the store URL is user input that we
 * probe server-side, so loopback/link-local/private ranges and internal
 * naming conventions are refused outright (SSRF guard). Request-time address
 * validation separately resolves every A and AAAA record and pins the socket.
 */
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  const literal = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  // WooCommerce stores need a certificate-bearing hostname. Rejecting all
  // literals also makes normalization fail closed before the request-time
  // DNS and address guard runs.
  if (isIP(literal)) return true
  return false
}

/**
 * Normalize and validate a user-entered store URL to an https origin plus
 * optional subdirectory path (WordPress installs under a path are common),
 * lowercased host, no trailing slash, no query/fragment/credentials, and no
 * private/internal hosts. Returns null for anything invalid, including
 * plain http.
 */
export function normalizeStoreUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (isDisallowedHost(url.hostname)) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `https://${url.host.toLowerCase()}${path}`
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildUrl(
  creds: WooCredentials,
  path: string,
  params: Record<string, string>,
): string {
  const url = new URL(`${creds.storeUrl}/wp-json/wc/v3${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

async function requestOnce(
  creds: WooCredentials,
  path: string,
  params: Record<string, string>,
  deps: WooApiClientDeps,
): Promise<Extract<PinnedFetchResult, { kind: 'ok' }>> {
  const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Basic ${basic}`,
  }
  const pinnedFetch = deps.pinnedFetch ?? pinnedHttpsFetch
  const result = await pinnedFetch(buildUrl(creds, path, params), {
    method: 'GET',
    headers,
    body: '',
    timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    maxResponseBytes: deps.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    rejectOversizeResponse: true,
  }, {
    validateUrl: deps.validateUrl,
    httpsRequest: deps.httpsRequest,
  })

  if (result.kind === 'ok') return result
  if (result.kind === 'redirect_blocked') {
    throw new WooCommerceApiError(
      `WooCommerce API ${result.status}: redirects are refused`,
      result.status,
      null,
      false,
    )
  }
  if (result.kind === 'unsafe_url') {
    throw new WooCommerceApiError('WooCommerce store address is not safe', 0, null, false)
  }
  if (result.kind === 'response_too_large') {
    throw new WooCommerceApiError('WooCommerce response exceeded the size limit', 0, null, false)
  }
  if (result.kind === 'timeout') {
    throw new WooCommerceApiError('WooCommerce request timed out', 0, null, true)
  }
  throw new WooCommerceApiError('WooCommerce request failed', 0, null, true)
}

function redactCredentials(value: string, creds: WooCredentials): string {
  const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const basicToken = Buffer.from(
    `${creds.consumerKey}:${creds.consumerSecret}`,
  ).toString('base64')
  let redacted = value
    .replace(
      /authorization\s*:\s*basic\s+[a-z0-9+/=_-]+/gi,
      'Authorization: [redacted]',
    )
    .replace(
      /\bconsumer_(?:key|secret)\s*=\s*[^&\s|,"']+/gi,
      '[redacted]',
    )
  if (basicToken) {
    redacted = redacted
      .replace(new RegExp(`basic\\s+${escapeRegExp(basicToken)}`, 'gi'), '[redacted]')
      .replaceAll(basicToken, '[redacted]')
  }
  for (const credential of [creds.consumerKey, creds.consumerSecret]) {
    if (!credential) continue
    redacted = redacted.replaceAll(credential, '[redacted]')
    const encoded = encodeURIComponent(credential)
    redacted = redacted.replace(
      new RegExp(escapeRegExp(encoded), 'gi'),
      '[redacted]',
    )
  }
  return redacted
}

function parseJson<T>(response: Extract<PinnedFetchResult, { kind: 'ok' }>): T {
  try {
    return JSON.parse(response.body) as T
  } catch {
    throw new WooCommerceApiError(
      `WooCommerce API ${response.status}: invalid JSON response`,
      response.status,
      null,
      false,
    )
  }
}

function parseError(
  response: Extract<PinnedFetchResult, { kind: 'ok' }>,
  creds: WooCredentials,
): WooCommerceApiError {
  let wooCode: string | null = null
  let detail = ''
  try {
    const body = JSON.parse(response.body) as { code?: string; message?: string }
    wooCode = body.code ?? null
    detail = redactCredentials(body.message ?? '', creds)
  } catch {
    // Non-JSON error body (host error page); the status is enough.
  }
  return new WooCommerceApiError(
    `WooCommerce API ${response.status}${detail ? `: ${detail}` : ''}`,
    response.status,
    wooCode,
  )
}

/**
 * GET a wc/v3 path. Retries network failures and 429/5xx with a short backoff.
 * Authorization failures are terminal.
 */
export async function wcGet<T>(
  creds: WooCredentials,
  path: string,
  params: Record<string, string> = {},
  deps: WooApiClientDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? sleepDefault
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response: Extract<PinnedFetchResult, { kind: 'ok' }>
    try {
      response = await requestOnce(creds, path, params, deps)
    } catch (err) {
      // Network/timeout errors: retry on the same backoff schedule.
      const requestError = err instanceof WooCommerceApiError
        ? err
        : new WooCommerceApiError('WooCommerce request failed', 0)
      lastError = requestError
      if (requestError.retryable && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      throw requestError
    }

    if (response.status >= 200 && response.status < 300) return parseJson<T>(response)

    if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      lastError = parseError(response, creds)
      await sleep(RETRY_DELAYS_MS[attempt])
      continue
    }
    throw parseError(response, creds)
  }
  throw lastError instanceof Error
    ? lastError
    : new WooCommerceApiError('WooCommerce request failed', 0)
}

export interface ListOrdersOptions {
  /** ISO timestamp; interpreted as UTC (dates_are_gmt is always sent). */
  modifiedAfter: string
  page: number
}

/**
 * One page of orders modified after the cursor, oldest-modified first so the
 * caller's cursor advances chronologically. Requires WooCommerce 5.8+
 * (modified_after); older stores fail with a woocommerce_rest_invalid_param
 * style error surfaced to the connection's error state.
 */
export async function listOrdersPage(
  creds: WooCredentials,
  options: ListOrdersOptions,
  deps: WooApiClientDeps = {},
): Promise<WooOrder[]> {
  return wcGet<WooOrder[]>(creds, '/orders', {
    modified_after: options.modifiedAfter,
    dates_are_gmt: 'true',
    status: 'any',
    orderby: 'modified',
    order: 'asc',
    per_page: String(WC_PAGE_SIZE),
    page: String(options.page),
  }, deps)
}

/** Hard cap on refund pages per order; a real order never approaches this. */
const MAX_REFUND_PAGES = 10

/**
 * All refunds of one order. Terminates on an EMPTY batch, not a short one
 * (hosts may cap per_page below our request, same as the order pagination),
 * dedupes by id so a host that ignores `page` cannot loop forever, and caps
 * total pages as a final backstop.
 */
export async function listOrderRefunds(
  creds: WooCredentials,
  orderId: number,
  deps: WooApiClientDeps = {},
): Promise<WooRefund[]> {
  const refunds: WooRefund[] = []
  const seen = new Set<number>()
  for (let page = 1; page <= MAX_REFUND_PAGES; page++) {
    const batch = await wcGet<WooRefund[]>(creds, `/orders/${orderId}/refunds`, {
      per_page: String(WC_PAGE_SIZE),
      page: String(page),
    }, deps)
    if (batch.length === 0) return refunds
    const fresh = batch.filter((r) => !seen.has(r.id))
    if (fresh.length === 0) return refunds
    for (const refund of fresh) seen.add(refund.id)
    refunds.push(...fresh)
  }
  // Cap exhausted with data still flowing: returning the partial list would
  // let the sync advance its cursor past refunds it never saw. Throwing
  // routes into the caller's refund-failure path instead (order held, cursor
  // capped, retried next run).
  throw new WooCommerceApiError(
    `Refund pagination cap exceeded for order ${orderId}`,
    0,
  )
}

/**
 * Verify credentials and read store metadata. The one-order probe is the
 * authoritative credential check (it exercises the read scope the feed
 * needs); title and settings lookups are best-effort extras.
 */
export async function testConnectionAndFetchStoreInfo(
  creds: WooCredentials,
  deps: WooApiClientDeps = {},
): Promise<WooStoreInfo> {
  await wcGet<unknown[]>(creds, '/orders', { per_page: '1' }, deps)

  const info: WooStoreInfo = {
    name: null,
    currency: null,
    prices_include_tax: null,
    wc_version: null,
  }

  try {
    const settings = await wcGet<Array<{ id: string; value: unknown }>>(
      creds,
      '/settings/general',
      {},
      deps,
    )
    const currency = settings.find((s) => s.id === 'woocommerce_currency')?.value
    if (typeof currency === 'string' && currency) info.currency = currency.toUpperCase()
    const pricesIncludeTax = settings.find((s) => s.id === 'woocommerce_prices_include_tax')?.value
    if (typeof pricesIncludeTax === 'string') info.prices_include_tax = pricesIncludeTax === 'yes'
  } catch {
    // Settings need broader permissions on some setups; the feed works without.
  }

  try {
    const status = await wcGet<{ environment?: { version?: string } }>(
      creds,
      '/system_status',
      {},
      deps,
    )
    if (status.environment?.version) info.wc_version = status.environment.version
  } catch {
    // system_status is admin-capability data and often blocked; optional.
  }

  try {
    // The WP REST index is public and carries the site title.
    const pinnedFetch = deps.pinnedFetch ?? pinnedHttpsFetch
    const response = await pinnedFetch(`${creds.storeUrl}/wp-json/`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      body: '',
      timeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      maxResponseBytes: deps.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      rejectOversizeResponse: true,
    }, {
      validateUrl: deps.validateUrl,
      httpsRequest: deps.httpsRequest,
    })
    if (response.kind === 'ok' && response.status >= 200 && response.status < 300) {
      const body = parseJson<{ name?: string }>(response)
      if (body.name) info.name = body.name
    }
  } catch {
    // Cosmetic only.
  }

  return info
}
