/**
 * Turning a mailbox hit into an underlag the user can approve.
 *
 * Lives in core rather than in the mail extension because it writes documents
 * and inbox items, and an extension may never import another extension. The
 * mail extension only ever hands over bytes.
 *
 * The hunt does NOT book anything and does not link anything by itself: it
 * stores the receipt before review, records where it came from, and stages the
 * pairing. Rejection does not imply that the stored candidate is deleted.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteDocument, uploadDocument } from '@/lib/core/documents/document-service'
import { getMailSearchService, type MailCandidate } from '@/lib/mail-search/service'
import { createLogger } from '@/lib/logger'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

const log = createLogger('receipt-hunt-ingest')

/**
 * What the bytes actually are, rather than what the mail claims.
 *
 * A mail's declared content type is untrusted metadata. Forwarded receipts
 * routinely arrive as `application/octet-stream` whatever they really are, and
 * uploadDocument validates the content against the type it is given, so
 * trusting the mail means every such receipt is rejected at the door. Measured
 * on a real mailbox: the first live fetch, an Elgiganten PDF, failed exactly
 * this way.
 *
 * Magic bytes first, then the filename, then whatever the mail said.
 */
export function sniffMimeType(bytes: Buffer, declared: string, filename: string): string {
  const head = bytes.subarray(0, 12)
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }

  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  const byExt: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  if (ext && byExt[ext]) return byExt[ext]

  return declared
}

/** Largest attachment worth pulling. Receipts are small; anything larger is a report. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export interface IngestedReceipt {
  documentId: string
  inboxItemId: string
  fileName: string
  mailbox: string
}

async function compensateUnlinkedUpload(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
): Promise<void> {
  try {
    const result = await deleteDocument(supabase, companyId, documentId)
    if (!result.ok) {
      log.warn('could not compensate unlinked hunted receipt', {
        documentId,
        reason: result.reason,
      })
    }
  } catch (error) {
    log.warn('could not compensate unlinked hunted receipt', {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Provenance written onto the inbox item.
 *
 * Deliberately in `channel_context` and not in `extracted_data`: retrying
 * extraction overwrites extracted_data wholesale, and the record of which
 * mailbox a receipt came from must survive that. Same rule the WhatsApp intake
 * follows.
 */
export function mailAttachmentIdentity(candidate: MailCandidate, attachmentId: string): string {
  return [candidate.provider, candidate.connectionId, candidate.messageId, attachmentId].join('::')
}

/** Identity written by the imported 20260807103000 migration. */
export function legacyMailAttachmentIdentity(
  candidate: MailCandidate,
  attachmentId: string,
): string {
  return [candidate.messageId, attachmentId].join('::')
}

/** Opaque model-facing identity for a message on one exact connection. */
export function mailMessageIdentity(candidate: MailCandidate): string {
  return [candidate.provider, candidate.connectionId, candidate.messageId].join('::')
}

function buildChannelContext(candidate: MailCandidate, attachmentId: string) {
  return {
    channel: 'mail_hunt',
    mail_message_id: candidate.messageId,
    mail_attachment_id: attachmentId,
    mail_connection_id: candidate.connectionId,
    // Message + attachment, because one forward can carry receipts for several
    // different purchases and each must be able to land separately. Taken from
    // the attachment being stored, not from index 0: filing a later attachment
    // under its sibling's key would block the sibling from ever landing.
    mail_file_key: mailAttachmentIdentity(candidate, attachmentId),
    mail_mailbox: candidate.mailbox,
    mail_provider: candidate.provider,
    mail_subject: candidate.subject,
    mail_from: candidate.from,
    mail_received_at: candidate.receivedAt,
    fetched_at: new Date().toISOString(),
  }
}

/**
 * Fetch the first usable attachment on a candidate and file it as an inbox item.
 *
 * Returns null when there is nothing to store (body-only receipt, oversized
 * attachment, or a duplicate we have already ingested). Never throws for one
 * bad message: a single unreadable attachment must not abort a night's hunt.
 */
export async function ingestMailCandidate(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  candidate: MailCandidate,
  signal?: AbortSignal,
): Promise<IngestedReceipt | null> {
  if (signal?.aborted) return null
  if (candidate.attachmentIds.length === 0) return null
  if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) return null
  if (signal?.aborted) return null

  const service = getMailSearchService()

  for (const [index, attachmentId] of candidate.attachmentIds.entries()) {
    // Per attachment, not per message: the check has to name the file it is
    // about, and it sits inside the loop so trying a second attachment is not
    // suppressed by the first one already being filed.
    const fileKey = mailAttachmentIdentity(candidate, attachmentId)
    const legacyFileKey = legacyMailAttachmentIdentity(candidate, attachmentId)
    const { data: exactExisting } = await supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', companyId)
      .eq('source', 'mail_hunt')
      .eq('channel_context->>mail_file_key', fileKey)
      .maybeSingle()
    if (exactExisting) continue
    const { data: legacyExisting } = await supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', companyId)
      .eq('source', 'mail_hunt')
      .eq('channel_context->>mail_legacy_file_key', legacyFileKey)
      // An unresolved imported alias is not globally unique across mailboxes.
      // Use every provenance field it carries, while allowing older rows that
      // genuinely predate provider or connection capture.
      .eq('channel_context->>mail_mailbox', candidate.mailbox)
      .or(
        `channel_context->>mail_provider.eq.${candidate.provider},` +
          'channel_context->>mail_provider.is.null',
      )
      .or(
        `channel_context->>mail_connection_id.eq.${candidate.connectionId},` +
          'channel_context->>mail_connection_id.is.null',
      )
      .maybeSingle()
    if (legacyExisting) continue
    if (signal?.aborted) return null

    let fetched
    let uploadedDocumentId: string | null = null
    try {
      fetched = await service.fetchAttachment(
        companyId,
        candidate.connectionId,
        candidate.messageId,
        attachmentId,
        signal,
      )
    } catch (error) {
      log.warn('could not fetch attachment', {
        messageId: candidate.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (!fetched) continue
    if (signal?.aborted) return null
    if (fetched.bytes.byteLength > MAX_ATTACHMENT_BYTES) continue
    // Fetching is an external round trip. Recheck before creating durable
    // storage in case the company's entitlement expired while Gmail replied.
    if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) return null
    if (signal?.aborted) return null

    try {
      // The name the search already reported beats the one the provider
      // re-derives on fetch: a second lookup can come back empty and fall back
      // to a generic "underlag.pdf", throwing away "2332687551.pdf".
      const knownName = candidate.attachmentNames?.[index]
      const fileName = knownName && knownName.length > 0 ? knownName : fetched.filename

      const document = await uploadDocument(
        supabase,
        userId,
        companyId,
        {
          name: fileName,
          buffer: fetched.bytes.buffer.slice(
            fetched.bytes.byteOffset,
            fetched.bytes.byteOffset + fetched.bytes.byteLength,
          ) as ArrayBuffer,
          type: sniffMimeType(fetched.bytes, fetched.mimeType, fileName),
        },
        { upload_source: 'mail_hunt' },
      )
      uploadedDocumentId = document.id
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Receipt hunt deadline exceeded')
      }

      // uploadDocument emits document.uploaded and awaits its handlers, so the
      // extraction extension has already read the amount, date and vendor out
      // of this file by the time we get here. Copying it onto the inbox item is
      // what lets the deterministic matcher pair the receipt on its amount:
      // the pool is read from invoice_inbox_items, and a row with no
      // extracted_data can never match anything.
      const { data: extractedRow } = await supabase
        .from('document_attachments')
        .select('extracted_data')
        .eq('id', document.id)
        .maybeSingle()
      const extracted = (extractedRow as { extracted_data?: Record<string, unknown> } | null)
        ?.extracted_data
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Receipt hunt deadline exceeded')
      }

      const { data: item, error } = await supabase
        .from('invoice_inbox_items')
        .insert({
          company_id: companyId,
          user_id: userId,
          document_id: document.id,
          source: 'mail_hunt',
          status: 'received',
          email_from: candidate.from,
          email_subject: candidate.subject,
          email_received_at: candidate.receivedAt,
          extracted_data: extracted ?? null,
          channel_context: buildChannelContext(candidate, attachmentId),
        })
        .select('id')
        .single()

      if (error) {
        await compensateUnlinkedUpload(supabase, companyId, document.id)
        uploadedDocumentId = null
        // 23505 is the partial unique index doing its job: another run got
        // there first, which is a success from the caller's point of view.
        if (error.code === '23505') return null
        throw new Error(error.message)
      }

      return {
        documentId: document.id,
        inboxItemId: (item as { id: string }).id,
        fileName,
        mailbox: candidate.mailbox,
      }
    } catch (error) {
      if (uploadedDocumentId) {
        await compensateUnlinkedUpload(supabase, companyId, uploadedDocumentId)
      }
      log.warn('could not store hunted receipt', {
        messageId: candidate.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Magic-byte rejection and the like: try the next attachment rather than
      // failing the whole candidate.
      continue
    }
  }

  return null
}
