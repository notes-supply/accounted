import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMfaEnforcementRequired, shouldEnforceMfa } from '@/lib/auth/mfa'

const serverConfigurationError = /REQUIRE_MFA must be explicitly set/
const publicConfigurationError = /NEXT_PUBLIC_REQUIRE_MFA must be explicitly set/

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('server runtime MFA configuration without test defaults', () => {
  it('rejects absent policies instead of inheriting an implicit disabled state', () => {
    vi.stubEnv('REQUIRE_MFA', undefined)
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', undefined)

    expect(() => isMfaEnforcementRequired()).toThrow(serverConfigurationError)
    expect(() => shouldEnforceMfa({ app_metadata: {} })).toThrow(
      serverConfigurationError,
    )
  })

  it.each(['', 'TRUE', 'yes', '1', ' true '])('rejects malformed server policy %j', value => {
    vi.stubEnv('REQUIRE_MFA', value)
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')

    expect(() => isMfaEnforcementRequired()).toThrow(serverConfigurationError)
  })

  it.each([undefined, '', 'TRUE', 'yes', '1', ' true '])(
    'rejects missing or malformed public policy %j',
    value => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)

      expect(() => isMfaEnforcementRequired()).toThrow(publicConfigurationError)
    },
  )

  it.each([
    ['true', 'false'],
    ['false', 'true'],
  ])('rejects a public/server policy disagreement: %s vs %s', (server, publicValue) => {
    vi.stubEnv('REQUIRE_MFA', server)
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', publicValue)

    expect(() => isMfaEnforcementRequired()).toThrow(/must match/)
  })

  it('accepts only explicit matching enabled and disabled policies', () => {
    vi.stubEnv('REQUIRE_MFA', 'false')
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
    expect(isMfaEnforcementRequired()).toBe(false)

    vi.stubEnv('REQUIRE_MFA', 'true')
    vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
    expect(isMfaEnforcementRequired()).toBe(true)
  })
})
