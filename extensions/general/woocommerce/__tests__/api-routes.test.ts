import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force the capability gate to run but stub requireCapability so entitlement
// is controlled per test. Mirrors the stripe/enable-banking suites.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

// Never let a unit test reach a real WooCommerce host: the credential probe
// is mocked, the pure helpers (normalizeStoreUrl) stay real.
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, testConnectionAndFetchStoreInfo: vi.fn() }
})

// The sync engine has its own suite; here it only needs to be callable.
vi.mock('../lib/order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-sync')>()
  return { ...actual, syncWooCommerceOrders: vi.fn() }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))

vi.mock('@/lib/commerce/order-sync-scheduler', () => ({
  claimCommerceOrderSyncConnection: vi.fn(),
  releaseCommerceOrderSyncClaim: vi.fn(),
  restoreCommerceOrderSyncClaim: vi.fn(),
}))

import { woocommerceExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { testConnectionAndFetchStoreInfo } from '../lib/api-client'
import { syncWooCommerceOrders } from '../lib/order-sync'
import { decryptCredential } from '../lib/credentials'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import {
  claimCommerceOrderSyncConnection,
  releaseCommerceOrderSyncClaim,
  restoreCommerceOrderSyncClaim,
} from '@/lib/commerce/order-sync-scheduler'
import { CommerceSyncPersistenceError } from '@/lib/commerce/order-sync-errors'

function findRoute(method: string, path: string) {
  const route = woocommerceExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path,
  )
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/woocommerce/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'woocommerce',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const USER = { id: 'user-1', is_anonymous: false }

const SYNC_SUMMARY = {
  fetched: 3,
  refundsFetched: 1,
  imported: 4,
  duplicates: 0,
  skippedLocked: 0,
  errors: 0,
}

describe('woocommerce extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.mocked(claimCommerceOrderSyncConnection).mockImplementation(
      async (_client, _table, connection) => ({
        connection,
        claimToken: 'opaque-claim-token',
        previousPriorityAt: connection.order_sync_priority_at,
      }),
    )
    vi.mocked(releaseCommerceOrderSyncClaim).mockResolvedValue(undefined)
    vi.mocked(restoreCommerceOrderSyncClaim).mockResolvedValue(undefined)
    vi.stubEnv('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('GET /status', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('prefers the active connection and reports configured', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [
          { id: 'c2', status: 'revoked' },
          { id: 'c1', status: 'active', store_url: 'https://shop.example.se' },
        ],
      })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.configured).toBe(true)
      expect(body.connection.id).toBe('c1')
    })
  })

  describe('POST /connect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('blocks anonymous (sandbox) users before any external call', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-1', is_anonymous: true } },
        error: null,
      })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.sandbox_blocked).toBe(true)
    })

    it('returns 403 capability_blocked when not entitled', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      vi.mocked(requireCapability).mockResolvedValue(
        capabilityBlockedResponse(CAPABILITY.woocommerce_sync),
      )
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'https://shop.example.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
    })

    it('rejects an invalid or http store URL with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'http://insecure.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('stages a pending row and returns the wc-auth authorize URL', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } }) // guardSandbox
      enqueue({ data: [] }) // no existing active/pending
      enqueue({ data: { id: 'conn-1' } }) // insert pending
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'Shop.Example.se/' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.url).toMatch(/^https:\/\/shop\.example\.se\/wc-auth\/v1\/authorize\?/)
      expect(body.url).toContain('scope=read')
      expect(body.url).toContain(
        encodeURIComponent('http://localhost:3000/api/extensions/woocommerce/callback'),
      )
      const inserted = findCall('woocommerce_connections', 'insert')?.[0] as Record<
        string,
        unknown
      >
      expect(inserted.store_url).toBe('https://shop.example.se')
      expect(inserted.status).toBe('pending')
      expect(inserted.oauth_state).toBeTruthy()
    })
  })

  describe('POST /manual-connect', () => {
    it('rejects missing keys with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://shop.example.se', consumer_key: 'ck_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('rejects with 400 when the credential probe fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      vi.mocked(testConnectionAndFetchStoreInfo).mockRejectedValue(new Error('401'))
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {
          store_url: 'https://shop.example.se',
          consumer_key: 'ck_x',
          consumer_secret: 'cs_y',
        }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('verifies, encrypts and activates on the happy path', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      enqueue({ data: { id: 'conn-1', store_url: 'https://shop.example.se' } }) // insert
      vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue({
        name: 'Testbutiken',
        currency: 'SEK',
        prices_include_tax: true,
        wc_version: '9.9.5',
      })
      const ctx = makeContext(supabase)
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {
          store_url: 'https://shop.example.se',
          consumer_key: 'ck_x',
          consumer_secret: 'cs_y',
        }),
        ctx,
      )
      expect(res.status).toBe(200)
      const inserted = findCall('woocommerce_connections', 'insert')?.[0] as Record<
        string,
        string
      >
      expect(inserted.status).toBe('active')
      expect(inserted.store_name).toBe('Testbutiken')
      // Secrets never stored in plaintext, and they decrypt back.
      expect(inserted.consumer_key_encrypted).not.toContain('ck_x')
      expect(decryptCredential(inserted.consumer_key_encrypted)).toBe('ck_x')
      expect(decryptCredential(inserted.consumer_secret_encrypted)).toBe('cs_y')
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'woocommerce.connected' }),
      )
    })
  })

  describe('POST /sync', () => {
    it('returns 404 without an active connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: null })
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('runs the sync on the service client and returns the summary', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { id: 'conn-1', status: 'active' } })
      vi.mocked(syncWooCommerceOrders).mockResolvedValue(SYNC_SUMMARY)
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.transactions.imported).toBe(4)
      expect(vi.mocked(syncWooCommerceOrders).mock.calls[0][0]).toEqual({ service: true })
      expect(releaseCommerceOrderSyncClaim).toHaveBeenCalledWith(
        { service: true },
        'woocommerce_connections',
        'conn-1',
        'opaque-claim-token',
        expect.any(Number),
      )
      expect(JSON.stringify(body)).not.toContain('opaque-claim-token')
    })

    it('returns 409 when cron or another manual sync owns the lease', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: {
          id: 'conn-1',
          status: 'active',
          order_sync_priority_at: '1970-01-01T00:00:00.000Z',
        },
      })
      vi.mocked(claimCommerceOrderSyncConnection).mockResolvedValueOnce(null)

      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )

      expect(res.status).toBe(409)
      expect(syncWooCommerceOrders).not.toHaveBeenCalled()
      expect(releaseCommerceOrderSyncClaim).not.toHaveBeenCalled()
    })

    it('releases its exact claim token when provider work throws', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: {
          id: 'conn-1',
          status: 'active',
          order_sync_priority_at: '1970-01-01T00:00:00.000Z',
        },
      })
      vi.mocked(syncWooCommerceOrders).mockRejectedValueOnce(new Error('provider failed'))

      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )

      expect(res.status).toBe(502)
      expect(releaseCommerceOrderSyncClaim).toHaveBeenCalledWith(
        { service: true },
        'woocommerce_connections',
        'conn-1',
        'opaque-claim-token',
        expect.any(Number),
      )
      expect(restoreCommerceOrderSyncClaim).not.toHaveBeenCalled()
    })

    it('returns non-2xx and preserves totals when release cannot be persisted', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { id: 'conn-1', status: 'active' } })
      vi.mocked(syncWooCommerceOrders).mockResolvedValueOnce(SYNC_SUMMARY)
      vi.mocked(releaseCommerceOrderSyncClaim).mockRejectedValueOnce(new Error('release failed'))

      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )

      expect(res.status).toBe(500)
      expect((await res.json()).transactions).toMatchObject({ imported: 4, errors: 0 })
    })

    it('returns non-2xx with partial totals for typed progress persistence failure', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { id: 'conn-1', status: 'active' } })
      vi.mocked(syncWooCommerceOrders).mockRejectedValueOnce(
        new CommerceSyncPersistenceError('checkpoint failed', 'progress_checkpoint', SYNC_SUMMARY),
      )

      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )

      expect(res.status).toBe(500)
      expect((await res.json()).transactions).toMatchObject({ imported: 4, errors: 0 })
    })

    it('does not release a lease already terminated by checked revocation', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { id: 'conn-1', status: 'active' } })
      vi.mocked(syncWooCommerceOrders).mockResolvedValueOnce({ ...SYNC_SUMMARY, revoked: true })

      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )

      expect(res.status).toBe(200)
      expect(releaseCommerceOrderSyncClaim).not.toHaveBeenCalled()
      expect(restoreCommerceOrderSyncClaim).not.toHaveBeenCalled()
    })

    it('restores queue priority when the start deadline expires before provider work', async () => {
      let nowMs = 0
      const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const connection = {
        id: 'conn-1',
        status: 'active',
        order_sync_priority_at: '1970-01-01T00:00:00.000Z',
      }
      enqueue({ data: connection })
      vi.mocked(claimCommerceOrderSyncConnection).mockImplementationOnce(
        async () => {
          nowMs = 180_000
          return {
            connection,
            claimToken: 'opaque-claim-token',
            previousPriorityAt: connection.order_sync_priority_at,
          }
        },
      )

      try {
        const res = await findRoute('POST', '/sync').handler(
          makeRequest('POST'),
          makeContext(supabase),
        )

        expect(res.status).toBe(504)
        expect(syncWooCommerceOrders).not.toHaveBeenCalled()
        expect(restoreCommerceOrderSyncClaim).toHaveBeenCalledWith(
          { service: true },
          'woocommerce_connections',
          expect.objectContaining({ claimToken: 'opaque-claim-token' }),
          expect.any(Number),
        )
        expect(releaseCommerceOrderSyncClaim).not.toHaveBeenCalled()
      } finally {
        now.mockRestore()
      }
    })
  })

  describe('POST /transaction-sync', () => {
    it('rejects a non-boolean enabled with 400', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: 'yes' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('persists the toggle for the active connection', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1' }] })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: false }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      expect(findCall('woocommerce_connections', 'update')?.[0]).toEqual({
        transaction_sync_enabled: false,
      })
    })
  })

  describe('DELETE /disconnect', () => {
    it('returns 404 when no connection exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('returns 409 when an exact non-expired lease owns the connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1', status: 'active', store_url: 'https://shop.example.se' }] })
      enqueue({ data: 'conflict' })

      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )

      expect(res.status).toBe(409)
    })

    it('returns 500 when atomic operational cleanup fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1', status: 'active', store_url: 'https://shop.example.se' }] })
      enqueue({ error: { message: 'cleanup failed' } })

      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )

      expect(res.status).toBe(500)
    })

    it('revokes (never deletes) and emits the audit event', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [{ id: 'conn-1', status: 'active', store_url: 'https://shop.example.se' }],
      })
      enqueue({ data: 'disconnected' })
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        ctx,
      )
      expect(res.status).toBe(200)
      expect(supabase.rpc).toHaveBeenCalledWith(
        'disconnect_commerce_connection',
        expect.objectContaining({
          p_provider: 'woocommerce',
          p_connection_id: 'conn-1',
          p_company_id: 'company-1',
          p_disconnected_at: expect.any(String),
        }),
      )
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'woocommerce.disconnected' }),
      )
    })
  })
})
