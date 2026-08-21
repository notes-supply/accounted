/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * Client display follows the public runtime flag. Server enforcement follows
 * the private runtime policy and is application-side, not RLS.
 */

import { flagEnabled } from '@/lib/env/public-flags'

/** Public runtime flag for client-visible MFA state. */
export function isMfaRequired(): boolean {
  return flagEnabled(process.env.NEXT_PUBLIC_REQUIRE_MFA)
}

/** Private server policy. Missing or malformed values fail closed. */
export function isMfaEnforcementRequired(): boolean {
  const privateValue = process.env.REQUIRE_MFA
  if (privateValue !== 'true' && privateValue !== 'false') {
    throw new Error('REQUIRE_MFA must be explicitly set to exactly "true" or "false"')
  }

  const publicValue = process.env.NEXT_PUBLIC_REQUIRE_MFA
  if (publicValue !== 'true' && publicValue !== 'false') {
    throw new Error(
      'NEXT_PUBLIC_REQUIRE_MFA must be explicitly set to exactly "true" or "false"',
    )
  }
  if (privateValue !== publicValue) {
    throw new Error('REQUIRE_MFA and NEXT_PUBLIC_REQUIRE_MFA must match')
  }

  return privateValue === 'true'
}

export function hasValidAssuranceLevel(
  data: unknown,
): data is { currentLevel: 'aal1' | 'aal2'; nextLevel: 'aal1' | 'aal2' } {
  if (!data || typeof data !== 'object') return false
  const aal = data as Record<string, unknown>
  return (
    (aal.currentLevel === 'aal1' || aal.currentLevel === 'aal2') &&
    (aal.nextLevel === 'aal1' || aal.nextLevel === 'aal2')
  )
}

/**
 * Check if MFA should be enforced for a specific user.
 * BankID-linked users skip TOTP because BankID is inherently 2FA.
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaEnforcementRequired()) return false
  if (user.app_metadata?.bankid_linked) return false
  return true
}
