/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * Client display follows the public setting. Server enforcement follows the
 * explicit runtime policy and never changes for self-hosted deployments.
 */

function readBooleanPolicy(name: string, value: string | undefined): boolean {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be explicitly set to exactly "true" or "false"`)
  }

  return value === 'true'
}

export function isMfaRequired(): boolean {
  return readBooleanPolicy(
    'NEXT_PUBLIC_REQUIRE_MFA',
    process.env.NEXT_PUBLIC_REQUIRE_MFA,
  )
}

export function isMfaEnforcementRequired(): boolean {
  // Keep this direct access intact: Next must read the server policy at runtime.
  const serverValue = process.env.REQUIRE_MFA

  if (serverValue !== 'true' && serverValue !== 'false') {
    throw new Error('REQUIRE_MFA must be explicitly set to exactly "true" or "false"')
  }

  if ((serverValue === 'true') !== isMfaRequired()) {
    throw new Error('REQUIRE_MFA and NEXT_PUBLIC_REQUIRE_MFA must match')
  }

  return serverValue === 'true'
}

export function hasValidAssuranceLevel(
  data: unknown,
): data is { currentLevel: 'aal1' | 'aal2'; nextLevel: 'aal1' | 'aal2' } {
  if (!data || typeof data !== 'object') return false
  const aal = data as Record<string, unknown>
  return (
    (aal.currentLevel === 'aal1' && aal.nextLevel === 'aal1') ||
    (aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') ||
    (aal.currentLevel === 'aal2' && aal.nextLevel === 'aal2')
  )
}

/**
 * Server enforcement is account-independent. The live session must prove
 * AAL2 whenever the runtime policy requires MFA.
 */
export function shouldEnforceMfa(_user: { app_metadata?: Record<string, unknown> }): boolean {
  return isMfaEnforcementRequired()
}
