import { describe, expect, it } from 'vitest'
import { shouldRefreshAfterInviteFailure } from '@/components/settings/invite-response'

describe('shouldRefreshAfterInviteFailure', () => {
  it('refreshes after a persisted pending invitation reports delivery failure', () => {
    expect(
      shouldRefreshAfterInviteFailure(502, {
        error: { code: 'INVITE_EMAIL_DELIVERY_FAILED' },
        data: {
          email: 'customer@example.com',
          status: 'pending',
          email_sent: false,
        },
      }),
    ).toBe(true)
  })

  it('does not refresh for an unrelated gateway failure or successful send', () => {
    expect(
      shouldRefreshAfterInviteFailure(502, {
        error: { code: 'TRANSIENT_ERROR' },
        data: {
          email: 'customer@example.com',
          status: 'pending',
          email_sent: false,
        },
      }),
    ).toBe(false)
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
