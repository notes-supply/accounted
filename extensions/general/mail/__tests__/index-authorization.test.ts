import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  canWriteCompany: vi.fn(),
  hasCapability: vi.fn(),
  createServiceClient: vi.fn(() => ({ service: true })),
  createOAuthState: vi.fn(() => 'signed-state'),
  verifyOAuthState: vi.fn(),
  buildAuthorizationUrl: vi.fn(() => 'https://accounts.google.test/authorize'),
  exchangeCodeForTokens: vi.fn(),
  getGoogleOAuthEnv: vi.fn(() => ({
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://app.test/callback',
  })),
  disconnect: vi.fn(),
  listConnections: vi.fn(),
  saveConnection: vi.fn(),
  updateBackfill: vi.fn(),
}))

vi.mock('@/lib/mail-search/service', () => ({ registerMailSearchService: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: mocks.createServiceClient,
}))
vi.mock('@/lib/auth/require-write', () => ({ canWriteCompany: mocks.canWriteCompany }))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: mocks.hasCapability }))
vi.mock('../lib/search-service', () => ({ GmailSearchService: class {} }))
vi.mock('../lib/crypto', () => ({
  createOAuthState: mocks.createOAuthState,
  verifyOAuthState: mocks.verifyOAuthState,
}))
vi.mock('../lib/google-oauth', () => ({
  buildAuthorizationUrl: mocks.buildAuthorizationUrl,
  exchangeCodeForTokens: mocks.exchangeCodeForTokens,
  getGoogleOAuthEnv: mocks.getGoogleOAuthEnv,
  isGoogleMailConfigured: vi.fn(() => true),
}))
vi.mock('../lib/connections', () => ({
  disconnect: mocks.disconnect,
  listConnections: mocks.listConnections,
  saveConnection: mocks.saveConnection,
  updateBackfill: mocks.updateBackfill,
}))
vi.mock('../lib/callback-origin', () => ({
  resolveCallbackOrigin: vi.fn(() => 'https://app.test'),
}))

import { mailExtension } from '../index'

function route(path: string, method: string) {
  const found = mailExtension.apiRoutes?.find((candidate) =>
    candidate.path === path && candidate.method === method
  )
  if (!found) throw new Error(`Missing route ${method} ${path}`)
  return found
}

const ctx = {
  userId: 'user-1',
  companyId: 'company-1',
  supabase: { scoped: true },
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canWriteCompany.mockResolvedValue(true)
  mocks.hasCapability.mockResolvedValue(true)
  mocks.verifyOAuthState.mockReturnValue({ userId: 'user-1', companyId: 'company-1' })
  mocks.exchangeCodeForTokens.mockResolvedValue({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date('2026-08-10T12:00:00Z'),
    scopes: ['gmail.readonly'],
    email: 'owner@example.com',
  })
})

describe('mail extension write authorization', () => {
  it.each([
    ['POST', '/oauth/start', 'https://app.test/api/extensions/ext/mail/oauth/start'],
    ['DELETE', '/connections', 'https://app.test/api/extensions/ext/mail/connections?id=conn-1'],
    ['POST', '/connections/backfill', 'https://app.test/api/extensions/ext/mail/connections/backfill'],
  ])('denies a viewer before %s %s can use the service role', async (method, path, url) => {
    mocks.canWriteCompany.mockResolvedValue(false)
    const request = new Request(url, {
      method,
      body: method === 'POST' && path.endsWith('backfill')
        ? JSON.stringify({ id: 'conn-1', days: 30 })
        : undefined,
    })

    const response = await route(path, method).handler(request, ctx as never)

    expect(response.status).toBe(403)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.updateBackfill).not.toHaveBeenCalled()
  })
})

describe('mail AI entitlement boundaries', () => {
  it('allows connection inspection after AI entitlement lapses', async () => {
    mocks.hasCapability.mockResolvedValue(false)
    mocks.listConnections.mockResolvedValue([])

    const response = await route('/connections', 'GET').handler(
      new Request('https://app.test/api/extensions/ext/mail/connections'),
      ctx as never,
    )

    expect(response.status).toBe(200)
    expect(mocks.listConnections).toHaveBeenCalledTimes(1)
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })

  it('allows a writable member to revoke credentials after AI entitlement lapses', async () => {
    mocks.hasCapability.mockResolvedValue(false)

    const response = await route('/connections', 'DELETE').handler(
      new Request('https://app.test/api/extensions/ext/mail/connections?id=conn-1', {
        method: 'DELETE',
      }),
      ctx as never,
    )

    expect(response.status).toBe(200)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })

  it.each([
    ['POST', '/oauth/start', {}],
    ['POST', '/connections/backfill', { id: 'conn-1', days: 30 }],
  ])('denies %s %s when AI entitlement has expired', async (method, path, body) => {
    mocks.hasCapability.mockResolvedValue(false)

    const response = await route(path, method).handler(
      new Request(`https://app.test/api/extensions/ext/mail${path}`, {
        method,
        body: JSON.stringify(body),
      }),
      ctx as never,
    )

    expect(response.status).toBe(403)
    expect(mocks.createOAuthState).not.toHaveBeenCalled()
    expect(mocks.updateBackfill).not.toHaveBeenCalled()
  })
})

describe('mail OAuth callback authorization', () => {
  const callback = () => route('/oauth/callback', 'GET')
  const request = () => new Request(
    'https://app.test/api/extensions/ext/mail/oauth/callback?code=code-1&state=state-1',
  )

  it('requires an authenticated callback context instead of bypassing dispatch auth', () => {
    expect(callback().skipAuth).not.toBe(true)
  })

  it.each(['revoked', 'downgraded'])('fails closed for a %s initiating member before token exchange', async () => {
    mocks.canWriteCompany.mockResolvedValue(false)

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=forbidden')
    expect(mocks.canWriteCompany).toHaveBeenCalledWith(ctx.supabase, 'user-1', 'company-1')
    expect(mocks.exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(mocks.saveConnection).not.toHaveBeenCalled()
  })

  it('fails closed when the callback actor differs from the signed state user', async () => {
    mocks.verifyOAuthState.mockReturnValue({ userId: 'other-user', companyId: 'company-1' })

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=forbidden')
    expect(mocks.canWriteCompany).not.toHaveBeenCalled()
    expect(mocks.exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('fails closed when the active callback company differs from the signed state company', async () => {
    mocks.verifyOAuthState.mockReturnValue({ userId: 'user-1', companyId: 'other-company' })

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=forbidden')
    expect(mocks.canWriteCompany).not.toHaveBeenCalled()
    expect(mocks.exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('revalidates the exact state membership immediately before exchanging the code', async () => {
    await callback().handler(request(), ctx as never)

    expect(mocks.canWriteCompany).toHaveBeenCalledWith(ctx.supabase, 'user-1', 'company-1')
    expect(mocks.canWriteCompany.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.exchangeCodeForTokens.mock.invocationCallOrder[0])
    expect(mocks.canWriteCompany).toHaveBeenCalledTimes(2)
    expect(mocks.hasCapability).toHaveBeenCalledTimes(2)
    expect(mocks.hasCapability).toHaveBeenNthCalledWith(1, ctx.supabase, 'company-1', 'ai')
    expect(mocks.hasCapability).toHaveBeenNthCalledWith(2, ctx.supabase, 'company-1', 'ai')
    expect(mocks.hasCapability.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.exchangeCodeForTokens.mock.invocationCallOrder[0])
    expect(mocks.hasCapability.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.saveConnection.mock.invocationCallOrder[0])
    expect(mocks.saveConnection).toHaveBeenCalledTimes(1)
  })

  it('does not exchange the code when AI entitlement expired before callback', async () => {
    mocks.hasCapability.mockResolvedValue(false)

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=entitlement_required')
    expect(mocks.exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(mocks.saveConnection).not.toHaveBeenCalled()
  })

  it('does not save credentials when AI entitlement expires during token exchange', async () => {
    mocks.hasCapability.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=entitlement_required')
    expect(mocks.exchangeCodeForTokens).toHaveBeenCalledTimes(1)
    expect(mocks.saveConnection).not.toHaveBeenCalled()
  })

  it('does not save tokens when the member is downgraded during the exchange', async () => {
    mocks.canWriteCompany.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callback().handler(request(), ctx as never)

    expect(response.headers.get('location')).toContain('mail=forbidden')
    expect(mocks.exchangeCodeForTokens).toHaveBeenCalledTimes(1)
    expect(mocks.saveConnection).not.toHaveBeenCalled()
  })
})
