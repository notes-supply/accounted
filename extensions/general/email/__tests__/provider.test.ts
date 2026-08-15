import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudflareEmailService } from '@/extensions/general/email/lib/cloudflare-service'
import { createEmailServiceFromEnv } from '@/extensions/general/email/lib/provider'
import { ResendEmailService } from '@/extensions/general/email/lib/resend-service'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('createEmailServiceFromEnv', () => {
  it('selects Cloudflare only inside the extension when its configuration is complete', () => {
    vi.stubEnv('CLOUDFLARE_EMAIL_ACCOUNT_ID', 'account-123')
    vi.stubEnv('CLOUDFLARE_EMAIL_API_TOKEN', 'test-token')
    vi.stubEnv('CLOUDFLARE_EMAIL_FROM', 'accounted@example.com')
    vi.stubEnv('RESEND_API_KEY', 'resend-test-key')
    vi.stubEnv('RESEND_FROM_EMAIL', 'resend@example.com')

    expect(createEmailServiceFromEnv()).toBeInstanceOf(CloudflareEmailService)
  })

  it.each([
    'CLOUDFLARE_EMAIL_ACCOUNT_ID',
    'CLOUDFLARE_EMAIL_API_TOKEN',
    'CLOUDFLARE_EMAIL_FROM',
  ] as const)('keeps the existing Resend provider when %s is absent', (missing) => {
    vi.stubEnv('CLOUDFLARE_EMAIL_ACCOUNT_ID', 'account-123')
    vi.stubEnv('CLOUDFLARE_EMAIL_API_TOKEN', 'test-token')
    vi.stubEnv('CLOUDFLARE_EMAIL_FROM', 'accounted@example.com')
    vi.stubEnv('RESEND_API_KEY', 'resend-test-key')
    vi.stubEnv('RESEND_FROM_EMAIL', 'resend@example.com')
    vi.stubEnv(missing, '')

    expect(createEmailServiceFromEnv()).toBeInstanceOf(ResendEmailService)
  })
})
