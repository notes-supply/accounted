import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { JournalEntrySourceTypeSchema } from '@/lib/api/schemas'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Guards against drift between the TS/Zod source_type allowlist and the DB
// CHECK constraint `journal_entries_source_type_check`. Originally added
// after a production incident where 'inbox_item' was in the TS type and
// Zod schema but missing from the DB constraint, causing every standalone
// "Bokför direkt" from the document inbox to fail with PG 23514.
describe('journal_entries.source_type CHECK constraint', () => {
  it.each(JournalEntrySourceTypeSchema.options)(
    'accepts source_type=%s',
    async (sourceType) => {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      const parentId = randomUUID()
      if (sourceType === 'storno' || sourceType === 'correction') {
        await getPool().query(
          `INSERT INTO public.journal_entries
             (id, user_id, company_id, fiscal_period_id, voucher_number,
              voucher_series, entry_date, description, source_type, status)
           VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'lineage parent', 'manual', 'draft')`,
          [parentId, userId, companyId, fiscalPeriodId],
        )
      }

      await expect(
        getPool().query(
          `INSERT INTO public.journal_entries
             (id, user_id, company_id, fiscal_period_id, voucher_number,
              voucher_series, entry_date, description, source_type, status,
              reverses_id, correction_of_id)
           VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', $5, $6, 'draft',
                   CASE WHEN $6 = 'storno' THEN $7::uuid END,
                   CASE WHEN $6 = 'correction' THEN $7::uuid END)`,
          [randomUUID(), userId, companyId, fiscalPeriodId, `src=${sourceType}`, sourceType, parentId],
        ),
      ).resolves.toBeDefined()
    },
  )

  it('rejects an unknown source_type value', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number,
            voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'bogus', 'not_a_real_source', 'draft')`,
        [randomUUID(), userId, companyId, fiscalPeriodId],
      ),
    ).rejects.toThrow(/source_type_check/i)
  })
})
