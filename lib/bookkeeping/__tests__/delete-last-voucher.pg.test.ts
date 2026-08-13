import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withErrorSavepoint, withUserContext } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

// Set up a posted journal entry with balanced lines, going through draft so
// the line-immutability trigger is happy. Returns the entry id.
async function insertPostedEntryWithLines(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  reversesId?: string
  sourceType?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status, reverses_id)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Test entry', $6, 'draft', $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.sourceType ?? 'manual',
      params.reversesId ?? null,
    ],
  )
  await insertBalancedLines(id)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [id],
  )
  return id
}

// Insert a document_attachment row already linked to a journal entry, so
// tests can exercise the bidirectional immutability trigger on the
// journal_entry_id column.
async function insertDocumentLinkedToEntry(params: {
  userId: string
  companyId: string
  journalEntryId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash,
        journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      params.userId,
      params.companyId,
      `test/${id}.pdf`,
      'receipt.pdf',
      'a'.repeat(64),
      params.journalEntryId,
    ],
  )
  return id
}

describe('delete_last_voucher.pg: RPC + immutability trigger interaction', () => {
  it('rejects an owner deleting an ordinary posted voucher without reusing its number', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await getPool().query(
      `INSERT INTO public.voucher_sequences
         (company_id, user_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 1)
       ON CONFLICT (company_id, fiscal_period_id, voucher_series)
       DO UPDATE SET last_number = EXCLUDED.last_number`,
      [companyId, userId, fiscalPeriodId],
    )

    await withUserContext(userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => client.query(
          `SELECT public.delete_last_voucher($1::uuid, $2::uuid)`,
          [companyId, entryId],
        ),
      )).rejects.toThrow(/Only genuine draft journal entries/i)

      const state = await client.query<{ entry_count: number; last_number: number }>(
        `SELECT
           (SELECT count(*)::integer FROM public.journal_entries WHERE id = $1) AS entry_count,
           (SELECT last_number FROM public.voucher_sequences
             WHERE company_id = $2
               AND fiscal_period_id = $3
               AND voucher_series = 'A') AS last_number`,
        [entryId, companyId, fiscalPeriodId],
      )
      expect(state.rows).toEqual([{ entry_count: 1, last_number: 1 }])
    })
  })

  it.each([
    { label: 'a numbered draft', voucherNumber: 7, committedAt: null },
    { label: 'a draft carrying commit evidence', voucherNumber: 0, committedAt: '2026-06-01T12:00:00Z' },
  ])('rejects $label as not a genuine draft', async ({ voucherNumber, committedAt }) => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber,
      committedAt,
    })
    await insertBalancedLines(entryId)

    await withUserContext(userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => client.query(
          `SELECT public.delete_last_voucher($1::uuid, $2::uuid)`,
          [companyId, entryId],
        ),
      )).rejects.toThrow(/Only genuine draft journal entries/i)
      const after = await client.query(
        `SELECT 1 FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(after.rowCount).toBe(1)
    })
  })

  it('blocks direct DELETE on a posted entry without the bypass flag', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    await expect(
      getPool().query(`DELETE FROM public.journal_entries WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/Cannot delete journal entries/i)
  })

  it('rejects a caller-set delete GUC and retains every posted artifact', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const documentId = await insertDocumentLinkedToEntry({
      userId,
      companyId,
      journalEntryId: entryId,
    })
    await getPool().query(
      `INSERT INTO public.voucher_sequences
         (company_id, user_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 1)
       ON CONFLICT (company_id, fiscal_period_id, voucher_series)
       DO UPDATE SET last_number = EXCLUDED.last_number`,
      [companyId, userId, fiscalPeriodId],
    )
    const beforeAudit = await getPool().query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM public.audit_log
        WHERE record_id = $1`,
      [entryId],
    )

    await withUserContext(userId, async (client) => {
      await client.query('SAVEPOINT caller_guc_attack')
      await client.query(
        `SELECT set_config('gnubok.allow_delete', 'true', true)`,
      )
      await expect(client.query(
        `DELETE FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )).rejects.toThrow(/Cannot delete journal entries/i)
      await client.query('ROLLBACK TO SAVEPOINT caller_guc_attack')

      const state = await client.query<{
        entry_count: number
        line_count: number
        linked_document_count: number
        last_number: number
        audit_count: number
      }>(
        `SELECT
           (SELECT count(*)::integer
              FROM public.journal_entries
             WHERE id = $1) AS entry_count,
           (SELECT count(*)::integer
              FROM public.journal_entry_lines
             WHERE journal_entry_id = $1) AS line_count,
           (SELECT count(*)::integer
              FROM public.document_attachments
             WHERE id = $2
               AND journal_entry_id = $1) AS linked_document_count,
           (SELECT last_number
              FROM public.voucher_sequences
             WHERE company_id = $3
               AND fiscal_period_id = $4
               AND voucher_series = 'A') AS last_number,
           (SELECT count(*)::integer
              FROM public.audit_log
             WHERE record_id = $1) AS audit_count`,
        [entryId, documentId, companyId, fiscalPeriodId],
      )
      expect(state.rows).toEqual([{
        entry_count: 1,
        line_count: 2,
        linked_document_count: 1,
        last_number: 1,
        audit_count: beforeAudit.rows[0]!.count,
      }])
    })
  })

  it('blocks UPDATE of arbitrary fields on a posted entry even when bypass flag is set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    const client = await getPool().connect()
    try {
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entries SET description = 'tampered' WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/Cannot modify a posted journal entry/i)
    } finally {
      client.release()
    }
  })

  it('unlinks an attached document only when deleting a genuine draft', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
    })
    await insertBalancedLines(entryId)
    const docId = await insertDocumentLinkedToEntry({
      userId,
      companyId,
      journalEntryId: entryId,
    })

    await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.delete_last_voucher($1::uuid, $2::uuid)`,
        [companyId, entryId],
      )
      const state = await client.query<{
        entry_count: number
        journal_entry_id: string | null
        audit_count: number
      }>(
        `SELECT
           (SELECT count(*)::integer FROM public.journal_entries WHERE id = $1) AS entry_count,
           (SELECT journal_entry_id FROM public.document_attachments WHERE id = $2) AS journal_entry_id,
           (SELECT count(*)::integer FROM public.audit_log
             WHERE table_name = 'journal_entries'
               AND record_id = $1
               AND action = 'DELETE') AS audit_count`,
        [entryId, docId],
      )
      expect(state.rows[0]).toMatchObject({
        entry_count: 0,
        journal_entry_id: null,
      })
      expect(state.rows[0]!.audit_count).toBeGreaterThanOrEqual(1)
    })
  })

  it('blocks reversed → posted UPDATE without the bypass flag', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a reversed journal entry/i)
  })

  // The bypass must remain narrow: an unauthorized direct UPDATE that clears
  // journal_entry_id outside delete_last_voucher (no gnubok.allow_delete
  // transaction-local flag) must still raise BFL_DOCUMENT_IMMUTABILITY.
  it('blocks direct UPDATE that nulls journal_entry_id without the bypass flag', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const documentId = await insertDocumentLinkedToEntry({
      userId, companyId, journalEntryId: entryId,
    })

    await expect(
      getPool().query(
        `UPDATE public.document_attachments SET journal_entry_id = NULL WHERE id = $1`,
        [documentId],
      ),
    ).rejects.toThrow(/BFL_DOCUMENT_IMMUTABILITY/)
  })

  // Drafts (voucher_number=0, never committed) can arise as orphans when a
  // mark-paid or similar engine flow fails between draft creation and commit.
  // They are not part of the verifikationsserie under BFL and must be
  // deletable so users can clean up their books.
  it('deletes a draft entry without touching the voucher series', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
    })
    await insertBalancedLines(draftId)

    await withUserContext(userId, async (client) => {
      const result = await client.query<{ delete_last_voucher: { deleted: boolean; was_draft: boolean } }>(
        `SELECT public.delete_last_voucher($1::uuid, $2::uuid)`,
        [companyId, draftId],
      )
      expect(result.rows[0]!.delete_last_voucher.deleted).toBe(true)
      expect(result.rows[0]!.delete_last_voucher.was_draft).toBe(true)

      const after = await client.query(
        `SELECT 1 FROM public.journal_entries WHERE id = $1`,
        [draftId],
      )
      expect(after.rowCount).toBe(0)
    })
  })

  it('deletes a draft even when the fiscal period is locked', async () => {
    // Drafts are not bokförda: period locks (which protect committed entries)
    // do not need to block draft cleanup.
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draftId = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId,
    })
    await insertBalancedLines(draftId)
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )

    await withUserContext(userId, async (client) => {
      await client.query(
        `SELECT public.delete_last_voucher($1::uuid, $2::uuid)`,
        [companyId, draftId],
      )
      const after = await client.query(
        `SELECT 1 FROM public.journal_entries WHERE id = $1`,
        [draftId],
      )
      expect(after.rowCount).toBe(0)
    })
  })

  it('pins the draft-delete RPC and trusted trigger execution boundary', async () => {
    const signature = 'public.delete_last_voucher(uuid,uuid)'
    const meta = await getPool().query(
      `SELECT delete_fn.prosecdef,
              delete_fn.proconfig,
              trigger_fn.prosecdef AS trigger_prosecdef,
              trigger_fn.proconfig AS trigger_proconfig,
              delete_fn.proowner = trigger_fn.proowner AS owners_match,
              pg_get_functiondef(trigger_fn.oid)
                LIKE '%current_user = v_guard_owner%' AS owner_guard,
              has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', $1, 'EXECUTE')
                AS authenticated_exec,
              has_function_privilege('service_role', $1, 'EXECUTE')
                AS service_exec,
              EXISTS (
                SELECT 1
                FROM aclexplode(
                  COALESCE(
                    delete_fn.proacl,
                    acldefault('f', delete_fn.proowner)
                  )
                ) acl
                WHERE acl.grantee = 0
                  AND acl.privilege_type = 'EXECUTE'
              ) AS public_exec
         FROM pg_proc delete_fn
         CROSS JOIN pg_proc trigger_fn
        WHERE delete_fn.oid = $1::regprocedure
          AND trigger_fn.oid =
            'public.enforce_journal_entry_immutability()'::regprocedure`,
      [signature],
    )
    expect(meta.rows).toEqual([{
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, public'],
      trigger_prosecdef: false,
      trigger_proconfig: ['search_path=pg_catalog, public'],
      owners_match: true,
      owner_guard: true,
      anon_exec: false,
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
    }])
  })
})
