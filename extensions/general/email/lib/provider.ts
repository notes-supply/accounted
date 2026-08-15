import type { EmailService } from '@/lib/email/service'
import { CloudflareEmailService } from './cloudflare-service'
import { ResendEmailService } from './resend-service'

export function createEmailServiceFromEnv(): EmailService {
  const cloudflare = new CloudflareEmailService()
  if (cloudflare.isConfigured()) return cloudflare

  return new ResendEmailService()
}
