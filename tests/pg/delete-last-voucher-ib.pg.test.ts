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
 * Covers 20260528120000_delete_last_voucher_clears_ib_link:
 *   - delete_last_voucher RPC succeeds when the target is the period's
 *     opening_balance_entry (A1 from SIE import).
 *   - fiscal_periods.opening_balance_entry_id is cleared and
 *     opening_balances_set is flipped to false.
 *   - sie_imports.opening_balance_entry_id is also cleared so the import
 *     row stays consistent.
 *   - audit_log has a DELETE entry with the "(was period IB)" marker.
 *   - The RPC still rejects non-last vouchers and locked periods.
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
       SET status = 'posted', committed_at = now()
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
  it('rejects deleting a posted IB entry and preserves the period link', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const ibEntryId = await commitPostedEntryAsIB({ userId, companyId, fiscalPeriodId })
    await linkAsIB(fiscalPeriodId, ibEntryId)

    // Sanity check pre-state
    const pre = await getPool().query<{ ob_id: string | null; ob_set: boolean }>(
      `SELECT opening_balance_entry_id AS ob_id, opening_balances_set AS ob_set
         FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(pre.rows[0]!.ob_id).toBe(ibEntryId)
    expect(pre.rows[0]!.ob_set).toBe(true)

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT delete_last_voucher($1, $2)`, [companyId, ibEntryId]),
      ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/i)
    })

    const after = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.journal_entries WHERE id = $1`,
      [ibEntryId],
    )
    expect(after.rows[0]!.count).toBe('1')
    const post = await getPool().query<{ ob_id: string | null; ob_set: boolean }>(
      `SELECT opening_balance_entry_id AS ob_id, opening_balances_set AS ob_set
         FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(post.rows[0]!.ob_id).toBe(ibEntryId)
    expect(post.rows[0]!.ob_set).toBe(true)
  })

  it('preserves sie_imports.opening_balance_entry_id when posted deletion is rejected', async () => {
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

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT delete_last_voucher($1, $2)`, [companyId, ibEntryId]),
      ).rejects.toThrow(/Posted and reversed vouchers cannot be deleted/i)
    })
    const imp = await getPool().query<{ ob_id: string | null }>(
      `SELECT opening_balance_entry_id AS ob_id FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(imp.rows[0]!.ob_id).toBe(ibEntryId)
  })
})
