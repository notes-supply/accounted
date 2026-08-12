import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommerceSyncPersistenceError } from '@/lib/commerce/order-sync-errors'

const verifyCronSecret = vi.fn((..._args: unknown[]) => null as unknown)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecret(...args),
}))

const registryGet = vi.fn()
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => registryGet(...args) },
}))

// Selection queries end in .limit(); claim and release mutations end in
// .maybeSingle(). This keeps the real scheduler under test through the route.
const rangeResult = vi.fn()
const limit = vi.fn()
const rpcResult = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: (...args: unknown[]) => rpcResult(...args),
    from: () => {
      const builder = {
        select: () => builder,
        update: () => builder,
        eq: () => builder,
        or: () => builder,
        order: () => builder,
        limit: (...args: unknown[]) => {
          limit(...args)
          return builder
        },
        maybeSingle: async () => ({ data: { id: 'claimed' }, error: null }),
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
          Promise.resolve(rangeResult()).then(resolve, reject),
      }
      return builder
    },
  })),
}))

const isWooCommerceConfigured = vi.fn((..._args: unknown[]) => true)
vi.mock('@/extensions/general/woocommerce/lib/credentials', () => ({
  isWooCommerceConfigured: (...args: unknown[]) => isWooCommerceConfigured(...args),
}))

const syncWooCommerceOrders = vi.fn()
vi.mock('@/extensions/general/woocommerce/lib/order-sync', () => ({
  syncWooCommerceOrders: (...args: unknown[]) => syncWooCommerceOrders(...args),
}))

const getCompanyIdsWithCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) =>
    getCompanyIdsWithCapability(...args),
}))

const CONNECTION = {
  id: 'conn-1',
  company_id: 'company-1',
  order_sync_priority_at: '1970-01-01T00:00:00.000Z',
}

const SUMMARY = {
  fetched: 2,
  refundsFetched: 0,
  imported: 2,
  duplicates: 0,
  skippedLocked: 0,
  errors: 0,
}

function connections(count: number, companyId: string, prefix = 'conn') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    company_id: companyId,
    order_sync_priority_at: '1970-01-01T00:00:00.000Z',
  }))
}

async function callRoute() {
  const { GET } = await import('../route')
  return GET(new Request('https://example.test/api/extensions/woocommerce/orders/cron'))
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockReturnValue({ id: 'woocommerce' })
  isWooCommerceConfigured.mockReturnValue(true)
  getCompanyIdsWithCapability.mockImplementation(
    async (_client: unknown, companyIds: string[]) => new Set(companyIds),
  )
  rpcResult.mockResolvedValue({ data: true, error: null })
  rangeResult.mockResolvedValue({ data: [CONNECTION], error: null })
  syncWooCommerceOrders.mockResolvedValue(SUMMARY)
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /api/extensions/woocommerce/orders/cron', () => {
  it('returns 401 when the cron secret is wrong', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })
    const res = await callRoute()
    expect(res.status).toBe(401)
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('refuses with 503 when the extension is not enabled', async () => {
    registryGet.mockReturnValue(undefined)
    const res = await callRoute()
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('EXTENSION_DISABLED')
  })

  it('no-ops when the encryption key is not configured', async () => {
    isWooCommerceConfigured.mockReturnValue(false)
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect((await res.json()).processed).toBe(0)
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('fails loudly when the connection query errors', async () => {
    rangeResult.mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } })
    const res = await callRoute()
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('syncs each eligible connection and reports the totals', async () => {
    rangeResult.mockResolvedValue({
      data: [CONNECTION, { id: 'conn-2', company_id: 'company-2' }],
      error: null,
    })

    const body = await (await callRoute()).json()

    expect(body.processed).toBe(2)
    expect(body.imported).toBe(4)
    expect(syncWooCommerceOrders).toHaveBeenCalledTimes(2)
    expect(getCompanyIdsWithCapability).toHaveBeenCalledTimes(1)
    expect(getCompanyIdsWithCapability.mock.calls[0][1]).toEqual([
      'company-1',
      'company-2',
    ])
    expect(syncWooCommerceOrders.mock.calls[0][0]).toBeTruthy()
    expect(typeof syncWooCommerceOrders.mock.calls[0][3]).toBe('number')
  })

  it('skips connections whose company is not entitled', async () => {
    getCompanyIdsWithCapability.mockResolvedValue(new Set())
    const body = await (await callRoute()).json()
    expect(body.processed).toBe(0)
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('records a failed connection without aborting the run', async () => {
    rangeResult.mockResolvedValue({
      data: [CONNECTION, { id: 'conn-2', company_id: 'company-2' }],
      error: null,
    })
    syncWooCommerceOrders
      .mockRejectedValueOnce(new Error('store on fire'))
      .mockResolvedValueOnce({
        fetched: 1,
        refundsFetched: 0,
        imported: 1,
        duplicates: 0,
        skippedLocked: 0,
        errors: 0,
      })

    const body = await (await callRoute()).json()

    expect(body.processed).toBe(2)
    expect(body.results.map((result: { status: string }) => result.status)).toEqual([
      'error',
      'synced',
    ])
  })

  it('marks a revoked connection in the results', async () => {
    syncWooCommerceOrders.mockResolvedValue({
      fetched: 0,
      refundsFetched: 0,
      imported: 0,
      duplicates: 0,
      skippedLocked: 0,
      errors: 0,
      revoked: true,
    })
    const body = await (await callRoute()).json()
    expect(body.results[0].status).toBe('revoked')
    expect(rpcResult.mock.calls.some(call => call[0] === 'release_commerce_order_sync_claim')).toBe(false)
  })

  it('retries a transient release failure without losing successful totals', async () => {
    let releases = 0
    rpcResult.mockImplementation(async (name: string) => {
      if (name === 'release_commerce_order_sync_claim' && releases++ === 0) {
        return { data: null, error: { message: 'temporary release failure' } }
      }
      return { data: true, error: null }
    })

    const res = await callRoute()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, imported: 2, duplicates: 0 })
    expect(releases).toBe(2)
  })

  it.each([
    ['persistent DB errors', { data: null, error: { message: 'release unavailable' } }],
    ['zero matched rows', { data: false, error: null }],
  ])('returns non-2xx with preserved totals for %s during release', async (_label, result) => {
    rpcResult.mockImplementation(async (name: string) =>
      name === 'release_commerce_order_sync_claim'
        ? result
        : { data: true, error: null },
    )

    const res = await callRoute()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toMatchObject({ processed: 1, imported: 2, duplicates: 0 })
    expect(body.results[0]).toMatchObject({ imported: 2, status: 'synced' })
  })

  it.each([
    ['progress checkpoint', 'progress_checkpoint'],
    ['credential revocation', 'credential_revocation'],
  ])('returns non-2xx with partial evidence for a typed %s failure', async (_label, operation) => {
    syncWooCommerceOrders.mockRejectedValueOnce(
      new CommerceSyncPersistenceError('durable write failed', operation, SUMMARY),
    )

    const res = await callRoute()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toMatchObject({ processed: 1, imported: 2, duplicates: 0 })
    expect(body.results[0]).toMatchObject({ imported: 2, status: 'error' })
  })

  it('pages past early ineligible rows and resolves repeated companies only once', async () => {
    const firstPage = connections(100, 'company-lapsed', 'lapsed-a')
    const secondPage = [
      ...connections(10, 'company-lapsed', 'lapsed-b'),
      ...connections(2, 'company-entitled', 'entitled'),
    ]
    rangeResult
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: secondPage, error: null })
    getCompanyIdsWithCapability.mockImplementation(
      async (_client: unknown, companyIds: string[]) =>
        new Set(companyIds.filter(companyId => companyId === 'company-entitled')),
    )

    const body = await (await callRoute()).json()

    expect(body.processed).toBe(2)
    expect(syncWooCommerceOrders).toHaveBeenCalledTimes(2)
    expect(getCompanyIdsWithCapability).toHaveBeenCalledTimes(2)
    expect(getCompanyIdsWithCapability.mock.calls[0][1]).toEqual(['company-lapsed'])
    expect(getCompanyIdsWithCapability.mock.calls[1][1]).toEqual(['company-entitled'])
    expect(limit.mock.calls).toEqual([[100], [100]])
  })

  it('caps the selected eligible batch at 50 connections', async () => {
    rangeResult.mockResolvedValueOnce({
      data: connections(100, 'company-entitled'),
      error: null,
    })

    const body = await (await callRoute()).json()

    expect(body.processed).toBe(50)
    expect(syncWooCommerceOrders).toHaveBeenCalledTimes(50)
    expect(limit).toHaveBeenCalledTimes(1)
    expect(getCompanyIdsWithCapability).toHaveBeenCalledTimes(1)
    expect(getCompanyIdsWithCapability.mock.calls[0][1]).toEqual(['company-entitled'])
  })

  it('rotates 50 failing attempts so the following healthy connection runs next', async () => {
    const failures = connections(50, 'company-failing', 'failure')
    const healthy = {
      id: 'healthy',
      company_id: 'company-healthy',
      order_sync_priority_at: '1970-01-01T00:00:00.000Z',
    }
    rangeResult.mockResolvedValueOnce({ data: [...failures, healthy], error: null })
    syncWooCommerceOrders.mockRejectedValue(new Error('permanent provider failure'))

    const first = await (await callRoute()).json()
    expect(first.processed).toBe(50)
    expect(first.results.every((result: { status: string }) => result.status === 'error')).toBe(true)

    syncWooCommerceOrders.mockReset()
    syncWooCommerceOrders.mockResolvedValue({ ...SUMMARY, imported: 1 })
    rangeResult.mockReset()
    rangeResult.mockResolvedValueOnce({ data: [healthy], error: null })

    const second = await (await callRoute()).json()
    expect(second.processed).toBe(1)
    expect(syncWooCommerceOrders.mock.calls[0][1].id).toBe('healthy')
  })

  it('fails loudly on a later paging error before syncing partial selections', async () => {
    rangeResult
      .mockResolvedValueOnce({
        data: connections(100, 'company-lapsed'),
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'second page failed', code: '500' },
      })
    getCompanyIdsWithCapability.mockResolvedValue(new Set())

    const res = await callRoute()

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('fails loudly when bulk entitlement resolution errors', async () => {
    getCompanyIdsWithCapability.mockRejectedValue(new Error('entitlements unavailable'))

    const res = await callRoute()

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('fails visibly when the first connection page consumes the selection budget', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    rangeResult.mockImplementationOnce(async () => {
      now = 180_000
      return { data: [CONNECTION], error: null }
    })

    const res = await callRoute()
    const body = await res.json()

    expect(res.status).toBe(504)
    expect(body.error).toMatchObject({
      code: 'CRON_SELECTION_TIMEOUT',
      message: 'Tidsgränsen nåddes innan urvalet för synkronisering blev klart.',
      message_en: 'The time budget was reached before sync selection completed.',
    })
    expect(getCompanyIdsWithCapability).not.toHaveBeenCalled()
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('fails visibly when bulk entitlement resolution consumes the selection budget', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    getCompanyIdsWithCapability.mockImplementationOnce(async () => {
      now = 180_000
      return new Set(['company-1'])
    })

    const res = await callRoute()

    expect(res.status).toBe(504)
    expect((await res.json()).error.code).toBe('CRON_SELECTION_TIMEOUT')
    expect(syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('fully selects the eligible batch before any sync can mutate a cursor', async () => {
    const events: string[] = []
    rangeResult
      .mockImplementationOnce(async () => {
        events.push('page-1')
        return { data: connections(100, 'company-lapsed'), error: null }
      })
      .mockImplementationOnce(async () => {
        events.push('page-2')
        return { data: [{ id: 'paid', company_id: 'company-paid' }], error: null }
      })
    getCompanyIdsWithCapability.mockImplementation(
      async (_client: unknown, companyIds: string[]) => {
        events.push(`bulk:${companyIds.join(',')}`)
        return new Set(companyIds.filter(companyId => companyId === 'company-paid'))
      },
    )
    syncWooCommerceOrders.mockImplementationOnce(async () => {
      events.push('sync')
      return { imported: 0, duplicates: 0 }
    })

    await callRoute()

    expect(events).toEqual([
      'page-1',
      'bulk:company-lapsed',
      'page-2',
      'bulk:company-paid',
      'sync',
    ])
  })
})
