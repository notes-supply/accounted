import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany, insertDraftJournalEntry } from '@/tests/pg/fixtures'

// Completed SIE imports may no longer hard-delete committed verifikationer.
// These regressions preserve the prior dimension-lineage coverage by asserting
// that every import-created or user-created registry row survives the rejected
// undo together with its posted references.

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
     VALUES ($1, $2, $3, 'undo-dims-test.se', $4, 4,
             '2026-01-01', '2026-12-31', 0, 1,
             'completed', $5, now())`,
    [id, params.userId, params.companyId, `hash-${id}`, params.fiscalPeriodId],
  )
  return id
}

/** Posted entry with dimension-tagged balanced lines. */
async function insertPostedTaggedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  sourceType: string
  voucherNumber: number
  dimensions: Record<string, string>
}): Promise<string> {
  const jeId = await insertDraftJournalEntry({
    userId: params.userId,
    companyId: params.companyId,
    fiscalPeriodId: params.fiscalPeriodId,
    sourceType: params.sourceType,
    status: 'draft',
    voucherNumber: params.voucherNumber,
  })
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
     VALUES ($1, '5010', 1000, 0, $2::jsonb),
            ($1, '1930', 0, 1000, '{}'::jsonb)`,
    [jeId, JSON.stringify(params.dimensions)],
  )
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [jeId],
  )
  return jeId
}

async function insertDimension(params: {
  companyId: string
  sieDimNo: number
  name: string
  importId?: string | null
  isSystem?: boolean
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimensions
       (company_id, sie_dim_no, name, resets_annually, is_system, created_by_import_id)
     VALUES ($1, $2, $3, true, $4, $5)
     RETURNING id`,
    [params.companyId, params.sieDimNo, params.name, params.isSystem ?? false, params.importId ?? null],
  )
  return rows[0].id
}

async function insertDimensionValue(params: {
  companyId: string
  dimensionId: string
  code: string
  importId?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.dimension_values
       (company_id, dimension_id, code, name, created_by_import_id)
     VALUES ($1, $2, $3, $3, $4)
     RETURNING id`,
    [params.companyId, params.dimensionId, params.code, params.importId ?? null],
  )
  return rows[0].id
}

// undo_sie_import honors p_user_id only for service_role callers
// (20260727121000), and these cases assert persisted state over the plain
// pool afterwards, so the call runs under a committing service-role context.
async function callUndo(companyId: string, importId: string, actor: string) {
  return runAsServiceRole((client) =>
    client.query<{ deleted: number }>(
      `SELECT public.undo_sie_import($1::uuid, $2::uuid, $3::uuid) AS deleted`,
      [companyId, importId, actor],
    ),
  )
}

async function expectUndoBlocked(
  companyId: string,
  importId: string,
  actor: string,
): Promise<void> {
  await expect(callUndo(companyId, importId, actor)).rejects.toMatchObject({
    code: '55000',
  })
}

async function countRows(table: string, id: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM public.${table} WHERE id = $1`,
    [id],
  )
  return rows.length
}

describe('undo_sie_import: dimension registry lockstep', () => {
  it('preserves import-created values and their committed references', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P001', importId })
    const entryId = await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'P001' },
    })

    await expectUndoBlocked(companyId, importId, userId)

    expect(await countRows('journal_entries', entryId)).toBe(1)
    expect(await countRows('dimension_values', valueId)).toBe(1)
    expect(await countRows('dimensions', dimId)).toBe(1)
  })

  it('preserves import-created values also referenced by other bookkeeping', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P002', importId })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'P002' },
    })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'manual', voucherNumber: 2,
      dimensions: { '6': 'P002' },
    })

    await expectUndoBlocked(companyId, importId, userId)

    expect(await countRows('dimension_values', valueId)).toBe(1)
  })

  it('never touches user-created values (no provenance)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const userValueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'EGEN', importId: null })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '6': 'EGEN' },
    })

    await expectUndoBlocked(companyId, importId, userId)

    // User-created provenance and the posted reference both remain.
    expect(await countRows('dimension_values', userValueId)).toBe(1)
  })

  it('preserves an import-created custom dimension and value', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 7, name: 'Anställd', importId })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'ANNA', importId })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '7': 'ANNA' },
    })

    await expectUndoBlocked(companyId, importId, userId)

    expect(await countRows('dimension_values', valueId)).toBe(1)
    expect(await countRows('dimensions', dimId)).toBe(1)
  })

  it('keeps an import-created dimension that still has user-created values', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })

    const dimId = await insertDimension({ companyId, sieDimNo: 8, name: 'Kund', importId })
    const userValueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'KUND1', importId: null })
    await insertPostedTaggedEntry({
      companyId, userId, fiscalPeriodId,
      sourceType: 'import', voucherNumber: 1,
      dimensions: { '8': 'KUND1' },
    })

    await expectUndoBlocked(companyId, importId, userId)

    // The user's value anchors the dimension.
    expect(await countRows('dimension_values', userValueId)).toBe(1)
    expect(await countRows('dimensions', dimId)).toBe(1)
  })

  it('deleting an old sie_imports row nulls provenance instead of cascading', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertCompletedImport({ companyId, userId, fiscalPeriodId })
    const dimId = await insertDimension({ companyId, sieDimNo: 6, name: 'Projekt' })
    const valueId = await insertDimensionValue({ companyId, dimensionId: dimId, code: 'P009', importId })

    await getPool().query(`DELETE FROM public.sie_imports WHERE id = $1`, [importId])

    const { rows } = await getPool().query<{ created_by_import_id: string | null }>(
      `SELECT created_by_import_id FROM public.dimension_values WHERE id = $1`,
      [valueId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].created_by_import_id).toBeNull()
  })
})
