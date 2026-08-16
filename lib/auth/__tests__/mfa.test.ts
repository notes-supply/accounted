import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  hasValidAssuranceLevel,
  isMfaEnforcementRequired,
  isMfaRequired,
  shouldEnforceMfa,
} from '../mfa'

describe('mfa helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isMfaRequired', () => {
    it('uses only the public setting for client display', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
      expect(isMfaRequired()).toBe(false)
    })

    it('returns true when explicitly required in self-hosted mode', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })

    it('returns true when hosted and MFA required', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })

    it.each([undefined, 'false'])(
      'returns false in self-hosted mode when NEXT_PUBLIC_REQUIRE_MFA is %s',
      value => {
        vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
        vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)
        expect(isMfaRequired()).toBe(false)
      },
    )
  })

  describe('isMfaEnforcementRequired', () => {
    it('returns true when the server setting enables MFA', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      expect(isMfaEnforcementRequired()).toBe(true)
    })

    it('returns false when the server setting disables MFA', () => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      expect(isMfaEnforcementRequired()).toBe(false)
    })

    it('rejects a missing server setting', () => {
      vi.stubEnv('REQUIRE_MFA', undefined)
      expect(() => isMfaEnforcementRequired()).toThrow(/REQUIRE_MFA/)
    })

    it.each(['TRUE', ' true ', 'yes', '1'])(
      'rejects malformed server setting %s',
      value => {
        vi.stubEnv('REQUIRE_MFA', value)
        expect(() => isMfaEnforcementRequired()).toThrow(/REQUIRE_MFA/)
      },
    )
  })

  describe('shouldEnforceMfa', () => {
    it('returns false when MFA is not required', () => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(false)
    })

    it('does not exempt an account merely because BankID is linked', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_linked: true } })).toBe(true)
    })

    it('returns true in self-hosted mode when the server requires MFA', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(true)
    })

    it('returns true when app_metadata is undefined', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({})).toBe(true)
    })
  })

  describe('hasValidAssuranceLevel', () => {
    it.each([
      null,
      undefined,
      {},
      { currentLevel: 'aal2' },
      { currentLevel: 'aal3', nextLevel: 'aal2' },
    ])('rejects absent or malformed assurance data: %j', value => {
      expect(hasValidAssuranceLevel(value)).toBe(false)
    })

    it('accepts a complete recognized assurance response', () => {
      expect(
        hasValidAssuranceLevel({ currentLevel: 'aal2', nextLevel: 'aal2' }),
      ).toBe(true)
    })
  })
})
