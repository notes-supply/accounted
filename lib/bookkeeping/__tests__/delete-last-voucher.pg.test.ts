import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  insertReversedJournalEntryGraph,
  seedCompany,
} from '@/tests/pg/fixtures'

// Durable posted fixture used by deletion rejection tests.
async function insertPostedEntryWithLines(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
}): Promise<string> {
  return insertPostedJournalEntry(params)
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
  it('rejects deleting the last posted voucher', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })

    await expect(
      withUserContext(userId, (client) =>
        client.query('SELECT delete_last_voucher($1, $2)', [companyId, entryId]),
      ),
    ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/)
  })

  it('rejects deleting a storno and leaves its original reversed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const graph = await insertReversedJournalEntryGraph({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 1,
    })

    await expect(
      withUserContext(userId, (client) =>
        client.query('SELECT delete_last_voucher($1, $2)', [companyId, graph.stornoId]),
      ),
    ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/)

    const original = await getPool().query(
      'SELECT status, reversed_by_id FROM public.journal_entries WHERE id = $1',
      [graph.originalId],
    )
    expect(original.rows[0]).toMatchObject({
      status: 'reversed',
      reversed_by_id: graph.stornoId,
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

  it('keeps document references when posted deletion is rejected', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntryWithLines({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
    })
    const documentId = await insertDocumentLinkedToEntry({
      userId,
      companyId,
      journalEntryId: entryId,
    })

    await expect(
      withUserContext(userId, (client) =>
        client.query('SELECT delete_last_voucher($1, $2)', [companyId, entryId]),
      ),
    ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/)

    const document = await getPool().query<{ journal_entry_id: string | null }>(
      'SELECT journal_entry_id FROM public.document_attachments WHERE id = $1',
      [documentId],
    )
    expect(document.rows[0]!.journal_entry_id).toBe(entryId)
  })

  it('blocks reversed to posted UPDATE without the bypass flag', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const graph = await insertReversedJournalEntryGraph({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: 1,
    })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
        [graph.originalId],
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
})
