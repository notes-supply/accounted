import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      verifyOtp,
      exchangeCodeForSession,
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({ data: null }),
        listFactors: vi.fn().mockResolvedValue({ data: null }),
      },
    },
    from: vi.fn(),
    rpc: vi.fn(),
  })),
}))

vi.mock('@/lib/auth/invite-tokens', () => ({
  hashInviteToken: vi.fn(),
}))

import { GET } from '../route'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /auth/callback: recovery flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  })

  it('redirects to /reset-password after a successful recovery OTP (token-hash flow)', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'recovery' })
  })

  it('uses the configured public origin instead of an internal request origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://public.example')
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://0.0.0.0:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://public.example/reset-password')
  })

  it('preserves the exact legacy callback host', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://public.example')
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://0.0.0.0:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
      { headers: { host: 'app.gnubok.se' } },
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://app.gnubok.se/reset-password')
  })

  it('rejects a legacy-host lookalike and uses the configured origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://public.example')
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://0.0.0.0:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
      { headers: { host: 'app.gnubok.se.evil.example' } },
    )
    const response = await GET(request)

    expect(response.headers.get('location')).toBe('https://public.example/reset-password')
  })

  it('fails closed when the public origin is missing behind private ingress', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')

    const request = new NextRequest(
      'http://0.0.0.0:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
    )
    const response = await GET(request)

    expect(response.status).toBe(500)
    expect(response.headers.get('location')).toBeNull()
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('fails closed when the configured public origin is malformed', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://public.example/path')

    const request = new NextRequest(
      'http://0.0.0.0:3000/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
    )
    const response = await GET(request)

    expect(response.status).toBe(500)
    expect(response.headers.get('location')).toBeNull()
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('retains the public HTTPS request-origin fallback for hosted deployments', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'https://tenant.example/auth/callback?token_hash=abc&type=recovery&next=/reset-password',
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://tenant.example/reset-password')
  })

  it('redirects to /reset-password after a successful PKCE exchange when next=/reset-password (no type param)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?code=xyz&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz')
  })

  it('tags a failed recovery link with flow=recovery so the login page shows reset copy', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=expired&type=recovery&next=/reset-password'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=recovery'
    )
  })

  it('tags a failed signup confirmation (PKCE code, no type/next) with flow=signup', async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: 'code verifier missing' },
    })

    const request = new NextRequest('http://localhost:3000/auth/callback?code=xyz')
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=signup'
    )
  })

  it('tags a failed OAuth code exchange (flow=oauth marker) with flow=oauth', async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: 'code verifier missing' },
    })

    const request = new NextRequest('http://localhost:3000/auth/callback?code=xyz&flow=oauth')
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=oauth'
    )
  })

  it('tags a provider denial (no code, only ?error from the provider) with flow=oauth', async () => {
    const request = new NextRequest(
      'http://localhost:3000/auth/callback?flow=oauth&error=access_denied'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/login?error=auth_error&flow=oauth'
    )
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

describe('GET /auth/callback: admin invite flow (type=invite)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  })

  it('routes a verified invite to /reset-password and preserves the invite token from next', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite&next=/invite/gnubok_inv_tok123'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc', type: 'invite' })
    // The company invite token is persisted as the pre-auth invite cookie so
    // the reset-password handoff can accept the membership after the
    // password is set.
    expect(response.headers.get('set-cookie') ?? '').toContain(
      'gnubok-invite-token=gnubok_inv_tok123'
    )
  })

  it('routes a verified invite without an invite path in next to /reset-password without the cookie', async () => {
    verifyOtp.mockResolvedValue({ error: null })

    const request = new NextRequest(
      'http://localhost:3000/auth/callback?token_hash=abc&type=invite'
    )
    const response = await GET(request)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost:3000/reset-password')
    expect(response.headers.get('set-cookie') ?? '').not.toContain('gnubok-invite-token')
  })
})
