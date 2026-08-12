import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The mail-hunt duplicate guard (migration 20260807103000).
 *
 * Receipts reach these mailboxes by being forwarded, and a single forward
 * routinely carries several of them: "Fwd: Kvitton februari" with five
 * attachments is five underlag, not one. The index that predated this
 * migration was unique on (company_id, mail_message_id), so filing the first
 * attachment silently and permanently blocked the other four.
 *
 * These tests pin the shape the hunt depends on: one row per attachment, the
 * same attachment refused twice, and the partial predicate keeping the index
 * out of the way of every other inbox source.
 */
async function insertHunted(companyId: string, userId: string, fileKey: string) {
  return getPool().query(
    `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status, channel_context)
     VALUES ($1, $2, 'mail_hunt', 'received', jsonb_build_object('mail_file_key', $3::text))
     RETURNING id`,
    [companyId, userId, fileKey],
  )
}

const compatibilityMigration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260810132000_mail_hunt_legacy_connection_dedupe.sql',
  ),
  'utf8',
)

describe('mail-hunt attachment dedupe (pg)', () => {
  it('accepts every attachment on one forwarded message', async () => {
    const { userId, companyId } = await seedCompany()
    const message = randomUUID()

    // Five receipts in one mail is the case that motivated the migration.
    for (const attachment of ['a', 'b', 'c', 'd', 'e']) {
      await insertHunted(companyId, userId, `gmail::conn-1::${message}::${attachment}`)
    }

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_inbox_items
       WHERE company_id = $1 AND source = 'mail_hunt'`,
      [companyId],
    )
    expect(rows[0].n).toBe(5)
  })

  it('refuses the same attachment twice, so a re-run is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    const fileKey = `gmail::conn-1::${randomUUID()}::att-1`

    await insertHunted(companyId, userId, fileKey)
    await expect(insertHunted(companyId, userId, fileKey)).rejects.toThrow(
      /duplicate key|idx_invoice_inbox_mail_file_unique/i,
    )
  })

  it('lets two companies hold the same attachment independently', async () => {
    // Two bookkeepers can be forwarded the same supplier invoice.
    const first = await seedCompany()
    const second = await seedCompany()
    const fileKey = `gmail::conn-1::${randomUUID()}::att-1`

    await insertHunted(first.companyId, first.userId, fileKey)
    await expect(insertHunted(second.companyId, second.userId, fileKey)).resolves.toBeTruthy()
  })

  it('keeps recurring same-name attachments distinct by provider connection and message', async () => {
    const { userId, companyId } = await seedCompany()

    await insertHunted(companyId, userId, 'gmail::conn-1::msg-july::att-1')
    await expect(
      insertHunted(companyId, userId, 'gmail::conn-1::msg-august::att-1'),
    ).resolves.toBeTruthy()

    await expect(
      insertHunted(companyId, userId, 'gmail::conn-1::msg-july::att-1'),
    ).rejects.toThrow(/duplicate key|idx_invoice_inbox_mail_file_unique/i)
  })

  it('allows equal provider message and attachment ids in different current connections', async () => {
    const { userId, companyId } = await seedCompany()

    await insertHunted(companyId, userId, 'gmail::conn-1::shared-msg::shared-att')
    await expect(
      insertHunted(companyId, userId, 'gmail::conn-2::shared-msg::shared-att'),
    ).resolves.toBeTruthy()
  })

  it('normalizes a legacy row only when tenant metadata proves one exact connection', async () => {
    const { userId, companyId } = await seedCompany()
    const connectionId = randomUUID()
    const legacyKey = `legacy-msg-${randomUUID()}::att-1`

    await getPool().query(
      `INSERT INTO public.mail_connections
         (id, company_id, provider, email_address, connected_by,
          encrypted_refresh_token, status)
       VALUES ($1, $2, 'gmail', 'owner@example.com', $3, 'encrypted', 'active')`,
      [connectionId, companyId, userId],
    )
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO public.invoice_inbox_items
         (company_id, user_id, source, status, channel_context)
       VALUES ($1, $2, 'mail_hunt', 'received', jsonb_build_object(
         'mail_message_id', split_part($3, '::', 1),
         'mail_attachment_id', 'att-1',
         'mail_file_key', $3::text,
         'mail_provider', 'gmail',
         'mail_mailbox', 'owner@example.com'
       ))
       RETURNING id`,
      [companyId, userId, legacyKey],
    )

    await getPool().query(compatibilityMigration)

    const { rows } = await getPool().query<{
      file_key: string
      connection_id: string
      legacy_key: string | null
    }>(
      `SELECT channel_context->>'mail_file_key' AS file_key,
              channel_context->>'mail_connection_id' AS connection_id,
              channel_context->>'mail_legacy_file_key' AS legacy_key
       FROM public.invoice_inbox_items
       WHERE id = $1`,
      [inserted.rows[0].id],
    )
    expect(rows[0]).toEqual({
      file_key: `gmail::${connectionId}::${legacyKey}`,
      connection_id: connectionId,
      legacy_key: null,
    })
  })

  it('keeps an ambiguous legacy key as a fail-safe compatibility alias', async () => {
    const { userId, companyId } = await seedCompany()
    const messageId = `ambiguous-${randomUUID()}`
    const legacyKey = `${messageId}::att-1`

    await getPool().query(
      `INSERT INTO public.mail_connections
         (company_id, provider, email_address, connected_by,
          encrypted_refresh_token, status)
       VALUES ($1, 'gmail', 'Owner@example.com', $2, 'encrypted-a', 'active'),
              ($1, 'gmail', 'owner@example.com', $2, 'encrypted-b', 'active')`,
      [companyId, userId],
    )
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO public.invoice_inbox_items
         (company_id, user_id, source, status, channel_context)
       VALUES ($1, $2, 'mail_hunt', 'received', jsonb_build_object(
         'mail_message_id', $3::text,
         'mail_attachment_id', 'att-1',
         'mail_file_key', $4::text,
         'mail_provider', 'gmail',
         'mail_mailbox', 'owner@example.com'
       ))
       RETURNING id`,
      [companyId, userId, messageId, legacyKey],
    )

    await getPool().query(compatibilityMigration)

    const { rows } = await getPool().query<{
      file_key: string
      connection_id: string | null
      legacy_key: string
    }>(
      `SELECT channel_context->>'mail_file_key' AS file_key,
              channel_context->>'mail_connection_id' AS connection_id,
              channel_context->>'mail_legacy_file_key' AS legacy_key
       FROM public.invoice_inbox_items
       WHERE id = $1`,
      [inserted.rows[0].id],
    )
    expect(rows[0]).toEqual({
      file_key: legacyKey,
      connection_id: null,
      legacy_key: legacyKey,
    })
  })

  it('leaves every other inbox source alone', async () => {
    // The index is partial on source = 'mail_hunt'. Uploads and WhatsApp
    // photos carry no file key and must not collide on a shared NULL.
    const { userId, companyId } = await seedCompany()

    for (let i = 0; i < 2; i++) {
      await getPool().query(
        `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status)
         VALUES ($1, $2, 'email', 'received')`,
        [companyId, userId],
      )
    }

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_inbox_items
       WHERE company_id = $1 AND source = 'email'`,
      [companyId],
    )
    expect(rows[0].n).toBe(2)
  })

  it('is the only unique index left on the hunted-mail key', async () => {
    // The message-scoped predecessor must be gone, or the five-attachment
    // case above would still fail in production.
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'invoice_inbox_items'
         AND indexname IN ('idx_invoice_inbox_mail_file_unique',
                           'idx_invoice_inbox_mail_message_unique')`,
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain('idx_invoice_inbox_mail_file_unique')
    expect(names).not.toContain('idx_invoice_inbox_mail_message_unique')
  })
})
