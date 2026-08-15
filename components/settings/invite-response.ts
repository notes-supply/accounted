export function shouldRefreshAfterInviteFailure(status: number, body: unknown): boolean {
  if (
    status !== 502 ||
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    !('data' in body)
  ) {
    return false
  }

  const error = body.error
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'INVITE_EMAIL_DELIVERY_FAILED'
  ) {
    return false
  }

  const data = body.data
  if (
    typeof data !== 'object' ||
    data === null ||
    !('email' in data) ||
    !('status' in data) ||
    !('email_sent' in data)
  ) {
    return false
  }

  return (
    typeof data.email === 'string' &&
    data.status === 'pending' &&
    data.email_sent === false
  )
}
