/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * MFA is required when the deployment explicitly enables it.
 * Enforcement is application-side (middleware + API routes), not RLS.
 */

export function isMfaRequired(): boolean {
  return process.env.NEXT_PUBLIC_REQUIRE_MFA === 'true'
}

export function isMfaEnforcementRequired(): boolean {
  // Keep this direct runtime access intact: Next must not inline the server policy.
  const serverValue = process.env.REQUIRE_MFA

  if (serverValue !== 'true' && serverValue !== 'false') {
    throw new Error('REQUIRE_MFA must be explicitly set to exactly "true" or "false"')
  }

  return serverValue === 'true'
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

/** Check if MFA should be enforced for a specific user. */
export function shouldEnforceMfa(_user: { app_metadata?: Record<string, unknown> }): boolean {
  return isMfaEnforcementRequired()
}
