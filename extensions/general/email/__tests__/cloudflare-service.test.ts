import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

import { CloudflareEmailService } from '@/extensions/general/email/lib/cloudflare-service'

const API_TOKEN = 'test-token-never-log'

beforeEach(() => {
  vi.stubEnv('CLOUDFLARE_EMAIL_ACCOUNT_ID', 'account-123')
  vi.stubEnv('CLOUDFLARE_EMAIL_API_TOKEN', API_TOKEN)
  vi.stubEnv('CLOUDFLARE_EMAIL_FROM', 'accounted@example.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CloudflareEmailService', () => {
  it('sends the generic email contract through the Cloudflare API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          delivered: ['customer@example.com'],
          permanent_bounces: [],
          queued: [],
          message_id: '<message-123@example.com>',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await new CloudflareEmailService().sendEmail({
      to: 'customer@example.com',
      cc: 'copy@example.com',
      replyTo: 'billing@example.com',
      fromName: 'Example AB\r\nBcc: injected@example.com',
      subject: 'Invitation',
      html: '<p>Welcome</p>',
      text: 'Welcome',
      attachments: [
        {
          filename: 'invite.txt',
          content: Buffer.from('invite'),
          contentType: 'text/plain',
        },
      ],
    })

    expect(result).toEqual({
      success: true,
      provider: 'cloudflare',
      messageId: '<message-123@example.com>',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/account-123/email/sending/send',
    )
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      from: {
        address: 'accounted@example.com',
        name: 'Example ABBcc: injected@example.com via Accounted',
      },
      to: ['customer@example.com'],
      cc: ['copy@example.com'],
      reply_to: 'billing@example.com',
      subject: 'Invitation',
      html: '<p>Welcome</p>',
      text: 'Welcome',
      attachments: [
        {
          filename: 'invite.txt',
          content: 'aW52aXRl',
          type: 'text/plain',
          disposition: 'attachment',
        },
      ],
    })
  })

  it('returns a stable rejection without exposing provider response data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            success: false,
            errors: [{ message: `Invalid bearer ${API_TOKEN}` }],
            result: null,
          },
          { status: 403 },
        ),
      ),
    )

    const result = await new CloudflareEmailService().sendEmail({
      to: 'customer@example.com',
      subject: 'Invitation',
      html: '<p>Welcome</p>',
    })

    expect(result).toEqual({
      success: false,
      provider: 'cloudflare',
      error: 'Cloudflare Email Service rejected the message',
    })
    expect(JSON.stringify(result)).not.toContain(API_TOKEN)
  })

  it('returns a stable failure when the production transport rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request failed with bearer ${API_TOKEN}`)),
    )

    const result = await new CloudflareEmailService().sendEmail({
      to: 'customer@example.com',
      subject: 'Invitation',
      html: '<p>Welcome</p>',
    })

    expect(result).toEqual({
      success: false,
      provider: 'cloudflare',
      error: 'Cloudflare Email Service request failed',
    })
    expect(JSON.stringify(result)).not.toContain(API_TOKEN)
  })

  it('does not report partial delivery with a permanent bounce as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          result: {
            delivered: ['copy@example.com'],
            permanent_bounces: ['customer@example.com'],
            queued: [],
            message_id: '<partial@example.com>',
          },
        }),
      ),
    )

    await expect(
      new CloudflareEmailService().sendEmail({
        to: 'customer@example.com',
        cc: 'copy@example.com',
        subject: 'Invoice',
        html: '<p>Invoice</p>',
      }),
    ).resolves.toEqual({
      success: false,
      provider: 'cloudflare',
      error: 'Cloudflare Email Service rejected the message',
    })
  })
})
