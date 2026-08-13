import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertBalancedLines,
} from '@/tests/pg/fixtures'
import { getPool, withErrorSavepoint, withUserContext } from '@/tests/pg/setup'

/**
 * Regression for the draft-only delete_last_voucher contract. A posted
 * opening-balance voucher is committed accounting evidence even when it is
 * last in its series. Physical deletion must fail before period, SIE-import,
 * voucher-sequence, or audit state changes.
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
       SET status = 'posted'
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

describe('delete_last_voucher with a committed opening-balance link', () => {
  it('rejects physical deletion and preserves every committed pointer and number', async () => {
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
      await expect(withErrorSavepoint(
        client,
        () => client.query(
          `SELECT delete_last_voucher($1, $2)`,
          [companyId, ibEntryId],
        ),
      )).rejects.toThrow(/Only genuine draft journal entries/i)

      const state = await client.query<{
        entry_count: number
        period_entry_id: string | null
        opening_balances_set: boolean
        import_entry_id: string | null
        last_number: number
        delete_audit_count: number
      }>(
        `SELECT
           (SELECT count(*)::integer FROM public.journal_entries
             WHERE id = $1) AS entry_count,
           (SELECT opening_balance_entry_id FROM public.fiscal_periods
             WHERE id = $2) AS period_entry_id,
           (SELECT opening_balances_set FROM public.fiscal_periods
             WHERE id = $2) AS opening_balances_set,
           (SELECT opening_balance_entry_id FROM public.sie_imports
             WHERE id = $3) AS import_entry_id,
           (SELECT last_number FROM public.voucher_sequences
             WHERE company_id = $4
               AND fiscal_period_id = $2
               AND voucher_series = 'A') AS last_number,
           (SELECT count(*)::integer FROM public.audit_log
             WHERE table_name = 'journal_entries'
               AND record_id = $1
               AND action = 'DELETE') AS delete_audit_count`,
        [ibEntryId, fiscalPeriodId, importId, companyId],
      )

      expect(state.rows).toEqual([{
        entry_count: 1,
        period_entry_id: ibEntryId,
        opening_balances_set: true,
        import_entry_id: ibEntryId,
        last_number: 1,
        delete_audit_count: 0,
      }])
    })
  })
})
