import { describe, expect, it } from 'vitest'
import { shouldRefreshAfterInviteFailure } from '@/components/settings/invite-response'

describe('shouldRefreshAfterInviteFailure', () => {
  it('refreshes after a persisted pending invitation reports delivery failure', () => {
    expect(
      shouldRefreshAfterInviteFailure(502, {
        error: 'Inbjudan skapades, men e-postmeddelandet kunde inte skickas.',
        data: {
          email: 'customer@example.com',
          status: 'pending',
          email_sent: false,
        },
      }),
    ).toBe(true)
  })

  it('does not refresh for an unrelated gateway failure or successful send', () => {
    expect(shouldRefreshAfterInviteFailure(502, { error: 'Gateway failure' })).toBe(false)
    expect(
      shouldRefreshAfterInviteFailure(200, {
        data: {
          email: 'customer@example.com',
          status: 'pending',
          email_sent: true,
        },
      }),
    ).toBe(false)
  })
})
