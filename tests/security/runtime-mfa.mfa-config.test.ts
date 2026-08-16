import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMfaEnforcementRequired, shouldEnforceMfa } from '@/lib/auth/mfa'

const configurationError = /REQUIRE_MFA must be explicitly set/

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('server runtime MFA configuration without test defaults', () => {
  it('rejects an absent policy instead of inheriting an implicit disabled state', () => {
    vi.stubEnv('REQUIRE_MFA', undefined)

    expect(() => isMfaEnforcementRequired()).toThrow(configurationError)
    expect(() => shouldEnforceMfa({ app_metadata: {} })).toThrow(configurationError)
  })

  it.each(['', 'TRUE', 'yes', '1', ' true '])(
    'rejects malformed policy %j',
    value => {
      vi.stubEnv('REQUIRE_MFA', value)

      expect(() => isMfaEnforcementRequired()).toThrow(configurationError)
    },
  )

  it('accepts only explicit enabled and disabled policies', () => {
    vi.stubEnv('REQUIRE_MFA', 'false')
    expect(isMfaEnforcementRequired()).toBe(false)

    vi.stubEnv('REQUIRE_MFA', 'true')
    expect(isMfaEnforcementRequired()).toBe(true)
  })
})
