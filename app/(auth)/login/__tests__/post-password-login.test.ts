import { describe, expect, it, vi } from 'vitest'
import {
  completePasswordLogin,
  performPasswordLogin,
} from '../post-password-login'

describe('completePasswordLogin', () => {
  it('uses a full navigation immediately after a successful password grant', () => {
    const navigate = vi.fn()

    completePasswordLogin('/', navigate)

    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('preserves a safe deep-link destination', () => {
    const navigate = vi.fn()

    completePasswordLogin('/api/mcp-oauth/authorize?client_id=test', navigate)

    expect(navigate).toHaveBeenCalledWith('/api/mcp-oauth/authorize?client_id=test')
  })

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/..//evil.example/steal',
    '/%2e%2e//evil.example/steal',
  ])('sanitizes hostile next value %s at the login navigation boundary', (destination) => {
    const navigate = vi.fn()

    completePasswordLogin(destination, navigate)

    expect(navigate).toHaveBeenCalledWith('/')
  })
})

describe('performPasswordLogin', () => {
  it('accepts an existing-company invite after the password grant and lands on the dashboard', async () => {
    const navigate = vi.fn()
    const acceptPendingInvite = vi.fn().mockResolvedValue(true)

    const error = await performPasswordLogin({
      signIn: vi.fn().mockResolvedValue({ error: null }),
      onSignedIn: vi.fn(),
      acceptPendingInvite,
      destination: '/settings',
      navigate,
    })

    expect(error).toBeNull()
    expect(acceptPendingInvite).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/')
  })

  it('keeps the explicit next path when there is no pending invite', async () => {
    const navigate = vi.fn()

    await performPasswordLogin({
      signIn: vi.fn().mockResolvedValue({ error: null }),
      onSignedIn: vi.fn(),
      acceptPendingInvite: vi.fn().mockResolvedValue(false),
      destination: '/api/mcp-oauth/authorize?client_id=test',
      navigate,
    })

    expect(navigate).toHaveBeenCalledWith('/api/mcp-oauth/authorize?client_id=test')
  })

  it('continues navigation after a transient invite failure so the retained cookie can be retried', async () => {
    const navigate = vi.fn()
    const acceptPendingInvite = vi.fn().mockResolvedValue(false)

    await performPasswordLogin({
      signIn: vi.fn().mockResolvedValue({ error: null }),
      onSignedIn: vi.fn(),
      acceptPendingInvite,
      destination: '/select-company',
      navigate,
    })

    expect(acceptPendingInvite).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/select-company')
  })

  it('does not attempt invite acceptance when password login fails', async () => {
    const loginError = new Error('invalid credentials')
    const acceptPendingInvite = vi.fn()
    const onSignedIn = vi.fn()
    const navigate = vi.fn()

    const error = await performPasswordLogin({
      signIn: vi.fn().mockResolvedValue({ error: loginError }),
      onSignedIn,
      acceptPendingInvite,
      destination: '/',
      navigate,
    })

    expect(error).toBe(loginError)
    expect(onSignedIn).not.toHaveBeenCalled()
    expect(acceptPendingInvite).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
