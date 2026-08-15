import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertBalancedLines,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers the durable delete_last_voucher boundary:
 *   - a committed opening-balance voucher cannot be deleted;
 *   - fiscal_periods and sie_imports retain their opening-balance references
 *     when the protected deletion is rejected.
 */

async function commitPostedEntryAsIB(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherSeries?: string
}): Promise<string> {
  const entryId = randomUUID()
  const series = params.voucherSeries ?? 'A'
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 1, $5, '2026-01-01', 'Ingående balans', 'opening_balance', 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId, series],
  )
  await insertBalancedLines(entryId, 5000)
  // flip to posted directly: bypass commit_journal_entry to keep this
  // test focused on the deletion RPC. voucher_sequences needs a row so the
  // delete RPC's FOR UPDATE lookup succeeds.
  await getPool().query(
    `UPDATE public.journal_entries
       SET status = 'posted', commit_method = 'legacy'
     WHERE id = $1`,
    [entryId],
  )
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (company_id, fiscal_period_id, voucher_series) DO UPDATE
       SET last_number = EXCLUDED.last_number`,
    [params.companyId, params.userId, params.fiscalPeriodId, series],
  )
  return entryId
}

async function linkAsIB(periodId: string, entryId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.fiscal_periods
       SET opening_balance_entry_id = $1,
           opening_balances_set     = true
     WHERE id = $2`,
    [entryId, periodId],
  )
}

describe('delete_last_voucher with IB link', () => {
  it('rejects deleting a posted IB and preserves the period link', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const ibEntryId = await commitPostedEntryAsIB({ userId, companyId, fiscalPeriodId })
    await linkAsIB(fiscalPeriodId, ibEntryId)

    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT delete_last_voucher($1, $2)`, [companyId, ibEntryId]),
      ),
    ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/)

    const state = await getPool().query<{
      ob_id: string | null
      ob_set: boolean
      entry_count: string
    }>(
      `SELECT
         period.opening_balance_entry_id AS ob_id,
         period.opening_balances_set AS ob_set,
         (SELECT count(*) FROM public.journal_entries entry WHERE entry.id = $2) AS entry_count
       FROM public.fiscal_periods period
       WHERE period.id = $1`,
      [fiscalPeriodId, ibEntryId],
    )
    expect(state.rows[0]).toEqual({
      ob_id: ibEntryId,
      ob_set: true,
      entry_count: '1',
    })
  })

  it('preserves sie_imports.opening_balance_entry_id when deletion is rejected', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const ibEntryId = await commitPostedEntryAsIB({ userId, companyId, fiscalPeriodId })
    await linkAsIB(fiscalPeriodId, ibEntryId)

    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, fiscal_period_id,
          opening_balance_entry_id, status, transactions_count)
       VALUES ($1, $2, $3, 'test.se', $4, 4, $5, $6, 'completed', 0)`,
      [importId, userId, companyId, randomUUID().replace(/-/g, ''), fiscalPeriodId, ibEntryId],
    )

    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT delete_last_voucher($1, $2)`, [companyId, ibEntryId]),
      ),
    ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/)

    const imported = await getPool().query<{ ob_id: string | null }>(
      `SELECT opening_balance_entry_id AS ob_id FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(imported.rows[0]!.ob_id).toBe(ibEntryId)
  })
})
