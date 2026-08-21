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
    it('uses only the public runtime flag for client display', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
      expect(isMfaRequired()).toBe(false)
    })

    it('allows self-hosted deployments to display mandatory MFA', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })
  })

  describe('isMfaEnforcementRequired', () => {
    it.each([
      ['true', true],
      ['false', false],
    ])('parses matching private/public runtime policy %s', (value, expected) => {
      vi.stubEnv('REQUIRE_MFA', value)
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)
      expect(isMfaEnforcementRequired()).toBe(expected)
    })

    it.each([undefined, '', 'TRUE', '1', ' true '])(
      'rejects missing or malformed private policy %s',
      value => {
        vi.stubEnv('REQUIRE_MFA', value)
        vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
        expect(() => isMfaEnforcementRequired()).toThrow(/REQUIRE_MFA/)
      },
    )

    it('rejects a valid private/public mismatch', () => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(() => isMfaEnforcementRequired()).toThrow(/must match/)
    })
  })

  describe('shouldEnforceMfa', () => {
    it('returns false when the private policy disables MFA', () => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(false)
    })

    it('retains the BankID exemption', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_linked: true } })).toBe(false)
    })

    it('enforces MFA in self-hosted mode when the private policy requires it', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(true)
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
