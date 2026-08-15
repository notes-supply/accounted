import { getBranding } from '@/lib/branding/service'
import type { EmailService, SendEmailOptions, SendEmailResult } from '@/lib/email/service'

interface CloudflareSendResponse {
  success?: boolean
  result?: {
    delivered?: string[]
    permanent_bounces?: string[]
    queued?: string[]
    message_id?: string
  } | null
}

const PROVIDER = 'cloudflare'
const REJECTED_ERROR = 'Cloudflare Email Service rejected the message'
const TRANSPORT_ERROR = 'Cloudflare Email Service request failed'

function addresses(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

function sanitizeHeaderPart(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim()
}

export class CloudflareEmailService implements EmailService {
  isConfigured(): boolean {
    return Boolean(
      process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID &&
        process.env.CLOUDFLARE_EMAIL_API_TOKEN &&
        process.env.CLOUDFLARE_EMAIL_FROM,
    )
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const accountId = process.env.CLOUDFLARE_EMAIL_ACCOUNT_ID
    const apiToken = process.env.CLOUDFLARE_EMAIL_API_TOKEN
    const fromEmail = process.env.CLOUDFLARE_EMAIL_FROM

    if (!accountId || !apiToken || !fromEmail) {
      return { success: false, provider: PROVIDER, error: 'Email service is not configured' }
    }

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: {
              address: fromEmail,
              name: options.fromName
                ? `${sanitizeHeaderPart(options.fromName)} via ${sanitizeHeaderPart(getBranding().appName)}`
                : sanitizeHeaderPart(getBranding().appName),
            },
            to: addresses(options.to),
            cc: options.cc ? addresses(options.cc) : undefined,
            bcc: options.bcc ? addresses(options.bcc) : undefined,
            reply_to: options.replyTo,
            subject: options.subject,
            html: options.html,
            text: options.text,
            attachments: options.attachments?.map((attachment) => ({
              filename: attachment.filename,
              content:
                typeof attachment.content === 'string'
                  ? attachment.content
                  : Buffer.from(attachment.content).toString('base64'),
              type: attachment.contentType ?? 'application/octet-stream',
              disposition: 'attachment',
            })),
          }),
        },
      )

      const payload = (await response.json()) as CloudflareSendResponse
      const acceptedCount =
        (payload.result?.delivered?.length ?? 0) + (payload.result?.queued?.length ?? 0)
      const hasPermanentBounce = (payload.result?.permanent_bounces?.length ?? 0) > 0
      const messageId = payload.result?.message_id

      if (
        !response.ok ||
        payload.success !== true ||
        hasPermanentBounce ||
        (!messageId && acceptedCount === 0)
      ) {
        return { success: false, provider: PROVIDER, error: REJECTED_ERROR }
      }

      return { success: true, provider: PROVIDER, messageId }
    } catch {
      // Provider and transport error bodies may echo request metadata. Return a
      // stable message so credentials cannot reach callers or their logs.
      return { success: false, provider: PROVIDER, error: TRANSPORT_ERROR }
    }
  }
}
