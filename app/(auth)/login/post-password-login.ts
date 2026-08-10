import { safeReturnTo } from '@/lib/auth/safe-return-to'

/**
 * Complete password login with a document navigation.
 *
 * Mobile Firefox can stall while the login page performs additional Supabase
 * calls immediately after the password grant. A document navigation lets the
 * server middleware enforce MFA and route onboarding, while pending invite
 * cookies remain available to the destination flow.
 */
export function completePasswordLogin(
  destination: string,
  navigate: (destination: string) => void = window.location.assign.bind(window.location),
): void {
  navigate(safeReturnTo(destination, '/'))
}

interface PerformPasswordLoginOptions<TError> {
  signIn: () => Promise<{ error: TError | null }>
  onSignedIn: () => void
  acceptPendingInvite: () => Promise<boolean>
  destination: string
  navigate?: (destination: string) => void
}

/**
 * Keep the pending-invite handoff on the successful side of the password
 * grant. The invite consumer owns definitive cookie clearing and retryable
 * retention; this helper only selects the final document destination.
 */
export async function performPasswordLogin<TError>({
  signIn,
  onSignedIn,
  acceptPendingInvite,
  destination,
  navigate,
}: PerformPasswordLoginOptions<TError>): Promise<TError | null> {
  const { error } = await signIn()
  if (error) return error

  onSignedIn()
  const acceptedInvite = await acceptPendingInvite()
  completePasswordLogin(acceptedInvite ? '/' : destination, navigate)
  return null
}
