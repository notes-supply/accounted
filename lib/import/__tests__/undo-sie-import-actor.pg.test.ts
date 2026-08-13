import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import {
  seedCompany,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertBalancedLines,
} from '@/tests/pg/fixtures'

// The actor resolution and least-privilege grants remain part of the contract,
// but completed imports may no longer hard-delete committed bookkeeping.
// Both the service-role 3-argument call and authenticated 2-argument call must
// now fail with SQLSTATE 55000 while preserving the import and journal rows.
// Unauthorized callers still fail earlier with SQLSTATE 42501.

async function insertCompletedImport(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, imported_at)
     VALUES ($1, $2, $3, 'undo-actor-test.se', $4, 4,
             '2026-01-01', '2026-12-31', 0, 1,
             'completed', $5, now())`,
    [id, params.userId, params.companyId, `hash-${id}`, params.fiscalPeriodId],
  )
  return id
}

// Seed one posted source_type='import' verifikat so undo has something to
// delete. Insert as draft + balanced lines, then commit the draft→posted
// transition (the balance trigger requires balanced lines on that step).
async function insertPostedImportEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: 'import',
    status: 'draft',
    voucherNumber: 1,
  })
  await insertBalancedLines(jeId, 1000)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [jeId],
  )
  return jeId
}

async function callUndo(companyId: string, importId: string, actor: string | null) {
  return runAsServiceRole((client) =>
    client.query<{ deleted: number }>(
      `SELECT public.undo_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
      [companyId, importId, actor],
    ),
  )
}

describe('undo_sie_import: explicit actor (service-client path)', () => {
  it('rejects committed undo for an owner on the service-role path', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const jeId = await insertPostedImportEntry({ companyId, userId, fiscalPeriodId })

    await expect(callUndo(companyId, importId, userId)).rejects.toMatchObject({
      code: '55000',
    })

    const { rows: jeRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [jeId],
    )
    expect(jeRows).toEqual([{ status: 'posted' }])

    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('completed')
  })

  it('rejects a completed import whose candidate entry is reversed', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const entryId = await insertPostedImportEntry({
      companyId,
      userId,
      fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [entryId],
    )

    await expect(callUndo(companyId, importId, userId)).rejects.toMatchObject({
      code: '55000',
    })
    const entry = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry.rows).toEqual([{ status: 'reversed' }])
  })

  it('raises when no authorising identity is supplied (auth.uid() NULL, p_user_id NULL)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    await expect(callUndo(companyId, importId, null)).rejects.toThrow(
      /owners and admins/i,
    )

    // The gate fired before any mutation: the import is untouched.
    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(rows[0].status).toBe('completed')
  })

  it('raises when p_user_id is not an owner/admin of the company', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    // A 'member' of the same company is still not allowed to undo.
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await expect(callUndo(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )

    // And a complete stranger (no membership) is rejected too.
    await expect(callUndo(companyId, importId, randomUUID())).rejects.toThrow(
      /owners and admins/i,
    )
  })

  it('ignores a spoofed p_user_id from an authenticated (non-service) caller', async () => {
    // 20260727121000: a member passing the OWNER's UUID as p_user_id over an
    // authenticated PostgREST session must stay pinned to their own
    // auth.uid(), be rejected with 42501, and delete nothing. Same guard as
    // replace_sie_import (20260727120000).
    const { companyId, userId: ownerId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importId = await insertCompletedImport({ companyId, userId: ownerId, fiscalPeriodId })
    const jeId = await insertPostedImportEntry({ companyId, userId: ownerId, fiscalPeriodId })

    await withUserContext(memberId, async (client) => {
      let raised: (Error & { code?: string }) | null = null
      try {
        await client.query(
          `SELECT public.undo_sie_import($1::uuid, $2::uuid, $3::uuid)`,
          [companyId, importId, ownerId],
        )
      } catch (err) {
        raised = err as Error & { code?: string }
      }
      expect(raised, 'spoofed p_user_id must not authorize').not.toBeNull()
      expect(raised!.message).toMatch(/owners and admins/i)
      expect(raised!.code).toBe('42501')
    })

    // The gate fired before any mutation.
    const { rows: impRows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(impRows[0].status).toBe('completed')
    const { rows: jeRows } = await getPool().query(
      `SELECT 1 FROM public.journal_entries WHERE id = $1`,
      [jeId],
    )
    expect(jeRows).toHaveLength(1)
  })

  it('does not grant EXECUTE to anon or PUBLIC (20260727121000 least privilege)', async () => {
    const { rows } = await getPool().query<{
      anon_can: boolean
      public_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
    }>(
      `SELECT has_function_privilege('anon', 'public.undo_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('public', 'public.undo_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS public_can,
              has_function_privilege('authenticated', 'public.undo_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.undo_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS service_role_can`,
    )
    expect(rows[0].anon_can, 'anon must not be able to call undo_sie_import').toBe(false)
    expect(rows[0].public_can, 'PUBLIC must not hold EXECUTE').toBe(false)
    expect(rows[0].authenticated_can).toBe(true)
    expect(rows[0].service_role_can).toBe(true)
  })

  it('rejects committed undo for an authenticated owner using the 2-arg signature', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const entryId = await insertPostedImportEntry({ companyId, userId, fiscalPeriodId })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.undo_sie_import($1::uuid, $2::uuid)`,
          [companyId, importId],
        ),
      ).rejects.toMatchObject({ code: '55000' })
    })

    const importRow = await getPool().query<{ status: string }>(
      `SELECT status FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows).toEqual([{ status: 'completed' }])
    const entryRow = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entryRow.rows).toEqual([{ status: 'posted' }])
  })
})
