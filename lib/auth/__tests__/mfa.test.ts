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
    it.each([
      ['false', false],
      ['true', true],
    ] as const)('accepts the explicit public policy %s', (value, expected) => {
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)
      expect(isMfaRequired()).toBe(expected)
    })

    it.each([undefined, '', 'TRUE', 'yes', '1', ' true '])(
      'rejects missing or malformed public policy %j',
      value => {
        vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)
        expect(() => isMfaRequired()).toThrow(
          /NEXT_PUBLIC_REQUIRE_MFA must be explicitly set/,
        )
      },
    )

    it('does not let self-hosting override an explicitly enabled public policy', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })
  })

  describe('isMfaEnforcementRequired', () => {
    it.each([
      ['false', false],
      ['true', true],
    ] as const)('accepts matching explicit policy %s', (value, expected) => {
      vi.stubEnv('REQUIRE_MFA', value)
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', value)
      expect(isMfaEnforcementRequired()).toBe(expected)
    })

    it.each([undefined, '', 'TRUE', 'yes', '1', ' true '])(
      'rejects missing or malformed server policy %j',
      value => {
        vi.stubEnv('REQUIRE_MFA', value)
        expect(() => isMfaEnforcementRequired()).toThrow(
          /REQUIRE_MFA must be explicitly set/,
        )
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
  })

  describe('shouldEnforceMfa', () => {
    it('does not let self-hosting disable an enabled server policy', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(true)
    })

    it('does not exempt an account because BankID is linked', () => {
      vi.stubEnv('REQUIRE_MFA', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_linked: true } })).toBe(true)
    })

    it('returns false only for an explicitly disabled server policy', () => {
      vi.stubEnv('REQUIRE_MFA', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'false')
      expect(shouldEnforceMfa({})).toBe(false)
    })
  })

  describe('hasValidAssuranceLevel', () => {
    it.each([
      null,
      undefined,
      {},
      { currentLevel: 'aal2' },
      { nextLevel: 'aal2' },
      { currentLevel: 'aal3', nextLevel: 'aal2' },
      { currentLevel: 'aal2', nextLevel: 'aal3' },
      { currentLevel: 'aal2', nextLevel: 'aal1' },
    ])('rejects absent or malformed assurance data: %j', value => {
      expect(hasValidAssuranceLevel(value)).toBe(false)
    })

    it.each([
      { currentLevel: 'aal1', nextLevel: 'aal1' },
      { currentLevel: 'aal1', nextLevel: 'aal2' },
      { currentLevel: 'aal2', nextLevel: 'aal2' },
    ])('accepts a complete recognized assurance response: %j', value => {
      expect(hasValidAssuranceLevel(value)).toBe(true)
    })
  })
})
