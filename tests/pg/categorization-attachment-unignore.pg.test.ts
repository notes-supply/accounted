import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { insertTransaction, seedCompany } from '@/tests/pg/fixtures'

async function seedIgnoredCategorization(): Promise<{
  companyId: string
  userId: string
  transactionId: string
  journalEntryId: string
}> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const transactionId = await insertTransaction({
    userId,
    companyId,
    isIgnored: true,
  })
  const journalEntryId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, source_id, status, committed_at,
          categorization_category, categorization_is_business)
       VALUES ($1, $2, $3, $4, 1, 'A', '2026-06-01', 'Categorization',
               'bank_transaction', $5, 'posted', now(), 'expense_software', true)`,
      [journalEntryId, userId, companyId, fiscalPeriodId, transactionId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount,
          currency, line_description, sort_order, dimensions)
       VALUES ($1, '5420', 100, 0, 'SEK', NULL, 0, '{}'::jsonb),
              ($1, '1930', 0, 100, 'SEK', NULL, 1, '{}'::jsonb)`,
      [journalEntryId],
    )
    await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return { companyId, userId, transactionId, journalEntryId }
}

describe('atomic categorization attachment ignored state', () => {
  it('clears is_ignored inside the attachment RPC transaction', async () => {
    const seeded = await seedIgnoredCategorization()
    const results = await runAsServiceRole(async (client) => {
      const call = () => client.query<{ result: { status: string } }>(
        `SELECT public.attach_transaction_categorization(
           $1, $2, $3, $4, NULL, NULL, '1930', 100,
           'expense_software', true, $5::jsonb
         ) AS result`,
        [
          seeded.companyId,
          seeded.transactionId,
          seeded.journalEntryId,
          seeded.userId,
          JSON.stringify([
            {
              account_number: '5420',
              debit_amount: 100,
              credit_amount: 0,
              line_description: null,
              dimensions: {},
            },
            {
              account_number: '1930',
              debit_amount: 0,
              credit_amount: 100,
              line_description: null,
              dimensions: {},
            },
          ]),
        ],
      )
      const first = await call()
      const second = await call()
      return [first.rows[0].result, second.rows[0].result]
    })

    expect(results.map((result) => result.status)).toEqual(['applied', 'already_applied'])

    const { rows } = await getPool().query<{
      journal_entry_id: string
      is_ignored: boolean
    }>(
      `SELECT journal_entry_id, is_ignored
       FROM public.transactions
       WHERE id = $1 AND company_id = $2`,
      [seeded.transactionId, seeded.companyId],
    )
    expect(rows).toEqual([{
      journal_entry_id: seeded.journalEntryId,
      is_ignored: false,
    }])
  })

  it('keeps direct pointer updates blocked outside the command capability', async () => {
    const seeded = await seedIgnoredCategorization()

    await expect(
      getPool().query(
        `UPDATE public.transactions
         SET journal_entry_id = $1
         WHERE id = $2 AND company_id = $3`,
        [seeded.journalEntryId, seeded.transactionId, seeded.companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const { rows } = await getPool().query<{
      journal_entry_id: string | null
      is_ignored: boolean
    }>(
      `SELECT journal_entry_id, is_ignored
       FROM public.transactions
       WHERE id = $1 AND company_id = $2`,
      [seeded.transactionId, seeded.companyId],
    )
    expect(rows).toEqual([{ journal_entry_id: null, is_ignored: true }])
  })
})
