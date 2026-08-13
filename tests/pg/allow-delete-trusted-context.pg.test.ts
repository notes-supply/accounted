import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withErrorSavepoint, withUserContext } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

async function expectStatementRejected(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<void> {
  await expect(
    withErrorSavepoint(client, () => client.query(sql, params)),
  ).rejects.toThrow()
}

describe('gnubok.allow_delete trusted execution context', () => {
  it('does not let an authenticated caller mutate posted lines or documents', async () => {
    const tenant = await seedCompany()
    const entryId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'manual',
      entryDate: '2026-06-15',
      committedAt: '2026-06-15T10:00:00Z',
      lines: [
        { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const lines = await getPool().query<{ id: string }>(
      `SELECT id
         FROM public.journal_entry_lines
        WHERE journal_entry_id = $1
        ORDER BY sort_order, id`,
      [entryId],
    )
    const lineId = lines.rows[0]!.id
    const documentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, journal_entry_id, journal_entry_line_id,
          file_name, mime_type, file_size_bytes, storage_path, sha256_hash,
          upload_source)
       VALUES ($1, $2, $3, $4, $5, 'underlag.pdf', 'application/pdf', 1024,
               $6, repeat('a', 64), 'file_upload')`,
      [
        documentId,
        tenant.userId,
        tenant.companyId,
        entryId,
        lineId,
        `test/${documentId}.pdf`,
      ],
    )

    await withUserContext(tenant.userId, async (client) => {
      await client.query(
        `SELECT set_config('gnubok.allow_delete', 'true', true)`,
      )

      await expectStatementRejected(
        client,
        `DELETE FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      await expectStatementRejected(
        client,
        `DELETE FROM public.journal_entry_lines WHERE id = $1`,
        [lineId],
      )
      await expectStatementRejected(
        client,
        `UPDATE public.journal_entry_lines
            SET account_number = '1940', debit_amount = 999
          WHERE id = $1`,
        [lineId],
      )
      await expectStatementRejected(
        client,
        `UPDATE public.document_attachments
            SET journal_entry_id = NULL, journal_entry_line_id = NULL
          WHERE id = $1`,
        [documentId],
      )
      await expectStatementRejected(
        client,
        `UPDATE public.document_attachments
            SET file_name = 'forged.pdf'
          WHERE id = $1`,
        [documentId],
      )

      const retainedLines = await client.query<{
        id: string
        account_number: string
        debit_amount: number
      }>(
        `SELECT id, account_number, debit_amount::double precision AS debit_amount
           FROM public.journal_entry_lines
          WHERE journal_entry_id = $1
          ORDER BY sort_order, id`,
        [entryId],
      )
      expect(retainedLines.rows).toHaveLength(2)
      expect(retainedLines.rows[0]).toMatchObject({
        id: lineId,
        account_number: '1930',
        debit_amount: 1000,
      })

      const retainedDocument = await client.query<{
        journal_entry_id: string
        journal_entry_line_id: string
        file_name: string
      }>(
        `SELECT journal_entry_id, journal_entry_line_id, file_name
           FROM public.document_attachments
          WHERE id = $1`,
        [documentId],
      )
      expect(retainedDocument.rows).toEqual([{
        journal_entry_id: entryId,
        journal_entry_line_id: lineId,
        file_name: 'underlag.pdf',
      }])
    })
  })

  it('pins guard ownership, invoker identity, search paths, and ACLs', async () => {
    const signatures = [
      'public.guard_trusted_journal_delete_context()',
      'public.guard_trusted_journal_line_delete_context()',
      'public.enforce_document_journal_entry_immutability()',
      'public.enforce_document_metadata_immutability()',
    ]
    const { rows } = await getPool().query<{
      signature: string
      owner_name: string
      security_definer: boolean
      config: string[] | null
      authenticated_can_execute: boolean
      service_role_can_execute: boolean
    }>(
      `SELECT
         p.oid::regprocedure::text AS signature,
         pg_get_userbyid(p.proowner) AS owner_name,
         p.prosecdef AS security_definer,
         p.proconfig AS config,
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AS authenticated_can_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE')
           AS service_role_can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.oid = ANY($1::regprocedure[])
       ORDER BY p.oid::regprocedure::text`,
      [signatures],
    )

    expect(rows).toHaveLength(signatures.length)
    for (const row of rows) {
      expect(row.owner_name).toBe('postgres')
      expect(row.security_definer).toBe(false)
      const searchPath = (row.config ?? []).find((item) =>
        item.startsWith('search_path='),
      )
      expect(searchPath).toContain('pg_catalog')
      expect(searchPath).toContain('public')
      expect(row.authenticated_can_execute).toBe(false)
      expect(row.service_role_can_execute).toBe(false)
    }

    const maintenance = await getPool().query<{
      signature: string
      owner_name: string
      security_definer: boolean
      authenticated_can_execute: boolean
      service_role_can_execute: boolean
    }>(
      `SELECT
         p.oid::regprocedure::text AS signature,
         pg_get_userbyid(p.proowner) AS owner_name,
         p.prosecdef AS security_definer,
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AS authenticated_can_execute,
         has_function_privilege('service_role', p.oid, 'EXECUTE')
           AS service_role_can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.oid = ANY($1::regprocedure[])
       ORDER BY p.oid::regprocedure::text`,
      [[
        'public.cleanup_sandbox_user(uuid)',
        'public.delete_last_voucher(uuid,uuid)',
      ]],
    )
    expect(maintenance.rows).toEqual([
      {
        signature: 'cleanup_sandbox_user(uuid)',
        owner_name: 'postgres',
        security_definer: true,
        authenticated_can_execute: false,
        service_role_can_execute: true,
      },
      {
        signature: 'delete_last_voucher(uuid,uuid)',
        owner_name: 'postgres',
        security_definer: true,
        authenticated_can_execute: true,
        service_role_can_execute: true,
      },
    ])
  })
})
