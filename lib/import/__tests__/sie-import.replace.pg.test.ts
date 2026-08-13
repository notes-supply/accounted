import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from '@/tests/pg/fixtures'

// Covers the Fortnox re-sync storage and authorization contracts.
// Completed imports no longer hard-delete period-wide committed bookkeeping:
// owner/admin calls fail with SQLSTATE 55000 and preserve entries, lines,
// documents, pointers, sequences, dimensions, and import state. The existing
// service-role actor resolution, authenticated fallback, unique-index behavior,
// statement timeout, overload shape, and least-privilege grants remain covered.

async function insertSIEImport(params: {
  companyId: string
  userId: string
  fileHash: string
  status: 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced'
  fiscalPeriodId?: string
  openingBalanceEntryId?: string
  fiscalYearStart?: string
  fiscalYearEnd?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, opening_balance_entry_id, imported_at)
     VALUES ($1, $2, $3, 'fortnox-export.se', $4, 4,
             $5, $6, 0, 0,
             $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash,
      params.fiscalYearStart ?? '2026-01-01',
      params.fiscalYearEnd ?? '2026-12-31',
      params.status,
      params.fiscalPeriodId ?? null,
      params.openingBalanceEntryId ?? null,
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
  return id
}

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  sourceType: 'import' | 'manual' | 'bank_transaction'
  voucherNumber: number
  voucherSeries?: string
  entryDate?: string
}): Promise<string> {
  const id = randomUUID()
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test entry', $8, 'posted')`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber,
        params.voucherSeries ?? 'A',
        params.entryDate ?? '2026-06-01',
        params.sourceType,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 100, 0),
              ($1, '3001', 0, 100)`,
      [id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return id
}

async function insertVoucherSequence(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  series: string
  lastNumber: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.companyId, params.userId, params.fiscalPeriodId, params.series, params.lastNumber],
  )
}

async function insertDocumentAttachment(params: {
  userId: string
  companyId: string
  journalEntryId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, sha256_hash, journal_entry_id, upload_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'file_upload')`,
    [
      id,
      params.userId,
      params.companyId,
      `test/${id}.pdf`,
      `test-${id}.pdf`,
      `sha256-${id}`,
      params.journalEntryId,
    ],
  )
  return id
}

// Every call goes through the 3-arg shape with an explicit actor, under the
// service-role context: auth.uid() is NULL there, so the owner/admin gate can
// only resolve through p_user_id, which the function honors for service_role
// alone. Commits on success (the assertions below read persisted state over
// the plain pool); a raise aborts and rolls back.
async function callReplace(companyId: string, importId: string, actor: string | null) {
  return runAsServiceRole((client) =>
    client.query<{ deleted: number }>(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
      [companyId, importId, actor],
    ),
  )
}

describe('sie_imports: partial unique index + replace flow', () => {
  it('blocks a second active row with the same (company_id, file_hash)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      insertSIEImport({
        companyId,
        userId,
        fileHash: hash,
        status: 'pending',
        fiscalPeriodId,
      }),
    ).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('allows a new pending row with the same hash once the prior row is replaced', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const priorId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    // Mark the prior row as replaced (simulating what replace_sie_import does)
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'replaced', replaced_at = now() WHERE id = $1`,
      [priorId],
    )

    // A new pending row with the same hash now succeeds
    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })

  it('rejects committed replacement and preserves entries, lines, pointers, sequence, and import', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const obEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importEntry1 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })
    const importEntry2 = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 3,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 4,
    })
    const txnEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'bank_transaction', voucherNumber: 5,
    })

    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 5,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1, opening_balances_set = true
        WHERE id = $2`,
      [obEntry, fiscalPeriodId],
    )
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
      openingBalanceEntryId: obEntry,
    })

    const auditBefore = await getPool().query<{ count: string }>(
      `SELECT count(*)::text
         FROM public.audit_log
        WHERE record_id = ANY($1::uuid[])`,
      [[obEntry, importEntry1, importEntry2]],
    )

    await expect(
      callReplace(companyId, importId, userId),
    ).rejects.toMatchObject({ code: '55000' })

    const entries = await getPool().query<{ id: string; status: string }>(
      `SELECT id, status
         FROM public.journal_entries
        WHERE id = ANY($1::uuid[])
        ORDER BY voucher_number`,
      [[obEntry, importEntry1, importEntry2, manualEntry, txnEntry]],
    )
    expect(entries.rows).toEqual([
      { id: obEntry, status: 'posted' },
      { id: importEntry1, status: 'posted' },
      { id: importEntry2, status: 'posted' },
      { id: manualEntry, status: 'posted' },
      { id: txnEntry, status: 'posted' },
    ])

    const lines = await getPool().query<{ count: string }>(
      `SELECT count(*)::text
         FROM public.journal_entry_lines
        WHERE journal_entry_id = ANY($1::uuid[])`,
      [[obEntry, importEntry1, importEntry2]],
    )
    expect(lines.rows[0]!.count).toBe('6')

    const sequence = await getPool().query<{ last_number: number }>(
      `SELECT last_number
         FROM public.voucher_sequences
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rows[0]?.last_number).toBe(5)

    const period = await getPool().query<{
      opening_balance_entry_id: string | null
      opening_balances_set: boolean
    }>(
      `SELECT opening_balance_entry_id, opening_balances_set
         FROM public.fiscal_periods
        WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(period.rows).toEqual([{
      opening_balance_entry_id: obEntry,
      opening_balances_set: true,
    }])

    const importRow = await getPool().query<{
      status: string
      replaced_at: string | null
      opening_balance_entry_id: string | null
    }>(
      `SELECT status, replaced_at, opening_balance_entry_id
         FROM public.sie_imports
        WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows).toEqual([{
      status: 'completed',
      replaced_at: null,
      opening_balance_entry_id: obEntry,
    }])

    const auditAfter = await getPool().query<{ count: string }>(
      `SELECT count(*)::text
         FROM public.audit_log
        WHERE record_id = ANY($1::uuid[])`,
      [[obEntry, importEntry1, importEntry2]],
    )
    expect(auditAfter.rows).toEqual(auditBefore.rows)
  })

  it('does not rewind voucher_sequences when committed replacement is rejected', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 2,
    })
    await insertVoucherSequence({
      companyId, userId, fiscalPeriodId, series: 'A', lastNumber: 2,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      callReplace(companyId, importId, userId),
    ).rejects.toMatchObject({ code: '55000' })

    const sequence = await getPool().query<{ last_number: number }>(
      `SELECT last_number
         FROM public.voucher_sequences
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rows[0]?.last_number).toBe(2)
  })

  it('rejects a completed import whose candidate entry is cancelled', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
      [entryId],
    )
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      callReplace(companyId, importId, userId),
    ).rejects.toMatchObject({ code: '55000' })
    const entry = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry.rows).toEqual([{ status: 'cancelled' }])
  })

  it('does not detach documents when committed replacement is rejected', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 2,
    })
    const attachedDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: importEntry,
    })
    const manualDoc = await insertDocumentAttachment({
      userId, companyId, journalEntryId: manualEntry,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      callReplace(companyId, importId, userId),
    ).rejects.toMatchObject({ code: '55000' })

    const documents = await getPool().query<{
      id: string
      journal_entry_id: string | null
    }>(
      `SELECT id, journal_entry_id
         FROM public.document_attachments
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[attachedDoc, manualDoc]],
    )
    expect(Object.fromEntries(
      documents.rows.map((row) => [row.id, row.journal_entry_id]),
    )).toEqual({
      [attachedDoc]: importEntry,
      [manualDoc]: manualEntry,
    })
  })

  it('replace_sie_import and undo_sie_import carry a raised statement_timeout', async () => {
    // Regression for the 8s-timeout cancellation (migration 20260629160000):
    // these RPCs run on the service-role REST client, which still inherits the
    // authenticator login role's 8s statement_timeout (service_role.rolconfig
    // is NULL). A large import's delete exceeded that and was cancelled, so the
    // functions now set a function-local statement_timeout well above 8s.
    const { rows } = await getPool().query<{ proname: string; proconfig: string[] | null }>(
      `SELECT proname, proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND proname IN ('replace_sie_import', 'undo_sie_import')`,
    )
    expect(rows.length).toBe(2)
    for (const fn of rows) {
      const timeout = (fn.proconfig ?? []).find(c => c.startsWith('statement_timeout='))
      expect(timeout, `${fn.proname} should set statement_timeout`).toBeTruthy()
      const seconds = Number(/statement_timeout=(\d+)s/.exec(timeout!)?.[1] ?? 0)
      expect(seconds).toBeGreaterThan(8)
    }
  })

  it('replace_sie_import on an already-replaced import raises', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.sie_imports
          SET status = 'replaced', replaced_at = now()
        WHERE id = $1`,
      [importId],
    )

    await expect(callReplace(companyId, importId, userId)).rejects.toThrow(
      /not found or not in completed status/,
    )
  })
})

// The owner/admin gate still fails closed before the committed-bookkeeping
// fence: missing, member, viewer, and spoofed identities get SQLSTATE 42501.
// Authorized service-role and authenticated calls reach the fence and get
// SQLSTATE 55000 without mutation.
describe('replace_sie_import: owner/admin authorization gate', () => {
  it('rejects an owner actor and preserves committed import entries', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const manualEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'manual', voucherNumber: 2,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      callReplace(companyId, importId, userId),
    ).rejects.toMatchObject({ code: '55000' })
    await expectUntouched(companyId, importId, importEntry)
    const manual = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [manualEntry],
    )
    expect(manual.rows).toEqual([{ status: 'posted' }])
  })

  it('rejects an admin actor at the committed-bookkeeping fence', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      callReplace(companyId, importId, adminId),
    ).rejects.toMatchObject({ code: '55000' })
    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises for an actor with no membership in the company', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    // A real user who simply belongs to a different company: the cross-tenant
    // case the pre-fix function allowed outright.
    const { userId: strangerId } = await seedCompany()
    await expect(callReplace(companyId, importId, strangerId)).rejects.toThrow(
      /owners and admins/i,
    )

    // And an id that matches no user at all.
    await expect(callReplace(companyId, importId, randomUUID())).rejects.toThrow(
      /owners and admins/i,
    )

    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises for a viewer-role member', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(callReplace(companyId, importId, viewerId)).rejects.toThrow(
      /owners and admins/i,
    )
    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises for a member-role member', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(callReplace(companyId, importId, memberId)).rejects.toThrow(
      /owners and admins/i,
    )
    await expectUntouched(companyId, importId, importEntry)
  })

  it('raises when no authorising identity is supplied at all', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    // Explicit NULL p_user_id, auth.uid() NULL under the service role.
    await expect(callReplace(companyId, importId, null)).rejects.toThrow(
      /owners and admins/i,
    )

    // 2-arg shape (p_user_id defaults to NULL): this is the exact call the
    // pre-fix function accepted from anon, and it must now raise.
    await expect(
      runAsServiceRole((client) =>
        client.query(
          `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
          [companyId, importId],
        ),
      ),
    ).rejects.toThrow(/owners and admins/i)

    await expectUntouched(companyId, importId, importEntry)
  })

  it('ignores a spoofed p_user_id from an authenticated (non-service) caller', async () => {
    // The impersonation hole this migration closes: EXECUTE is granted to
    // `authenticated`, so any signed-in user can call the RPC over PostgREST.
    // A viewer passing the OWNER's UUID as p_user_id must still be pinned to
    // their own auth.uid(), rejected with 42501, and nothing may be deleted:
    // otherwise a known company/import/owner triple is a cross-tenant hard
    // delete of posted verifikationer.
    const { companyId, userId: ownerId, fiscalPeriodId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const importEntry = await insertPostedEntry({
      userId: ownerId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId: ownerId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    for (const spoofer of [viewerId, memberId]) {
      await withUserContext(spoofer, async (client) => {
        let raised: (Error & { code?: string }) | null = null
        try {
          await client.query(
            `SELECT public.replace_sie_import($1::uuid, $2::uuid, $3::uuid)`,
            [companyId, importId, ownerId],
          )
        } catch (err) {
          raised = err as Error & { code?: string }
        }
        expect(raised, 'spoofed p_user_id must not authorize').not.toBeNull()
        expect(raised!.message).toMatch(/owners and admins/i)
        // Explicit errcode so the route can map the raise to a 403.
        expect(raised!.code).toBe('42501')
      })
    }

    await expectUntouched(companyId, importId, importEntry)
  })

  it('rejects an authenticated owner using the 2-arg signature', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importEntry = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, sourceType: 'import', voucherNumber: 1,
    })
    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `SELECT public.replace_sie_import($1::uuid, $2::uuid)`,
          [companyId, importId],
        ),
      ).rejects.toMatchObject({ code: '55000' })
    })
    await expectUntouched(companyId, importId, importEntry)
  })

  it('exposes only the guarded undo and replace signatures', async () => {
    const { rows: overloads } = await getPool().query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('replace_sie_import', 'undo_sie_import')
        ORDER BY p.proname`,
    )
    expect(overloads.map((row) => row.signature)).toEqual([
      'replace_sie_import(uuid,uuid,uuid)',
      'undo_sie_import(uuid,uuid,uuid)',
    ])

    const { rows } = await getPool().query<{
      anon_can: boolean
      public_can: boolean
      authenticated_can: boolean
      service_role_can: boolean
    }>(
      `SELECT has_function_privilege('anon', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS anon_can,
              has_function_privilege('public', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS public_can,
              has_function_privilege('authenticated', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS authenticated_can,
              has_function_privilege('service_role', 'public.replace_sie_import(uuid,uuid,uuid)', 'EXECUTE') AS service_role_can`,
    )
    expect(rows[0]!.anon_can, 'anon must not be able to call replace_sie_import').toBe(false)
    expect(rows[0]!.public_can, 'PUBLIC must not hold EXECUTE').toBe(false)
    // The app calls the RPC on the service client, falling back to the
    // caller's session client when SUPABASE_SERVICE_ROLE_KEY is unset
    // (rpcClientForBulkDelete in lib/import/sie-import.ts).
    expect(rows[0]!.authenticated_can).toBe(true)
    expect(rows[0]!.service_role_can).toBe(true)
  })
})

// The gate must fire before any mutation: the import row, its verifikat and
// the allow_delete-protected data are all still there after a rejected call.
async function expectUntouched(companyId: string, importId: string, entryId: string) {
  const imp = await getPool().query<{ status: string }>(
    `SELECT status FROM public.sie_imports WHERE id = $1 AND company_id = $2`,
    [importId, companyId],
  )
  expect(imp.rows[0]?.status).toBe('completed')

  const je = await getPool().query<{ status: string }>(
    `SELECT status FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  expect(je.rows[0]?.status).toBe('posted')
}
