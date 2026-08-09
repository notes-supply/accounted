import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'
import { getPool, withUserContext } from './setup'

const ATTACH_SQL = `
  SELECT public.attach_transaction_categorization(
    $1, $2, $3, $4, $5, $6, $7, $8
  ) AS attached
`

const ATTACHMENT_MIGRATION_SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260808160000_atomic_transaction_categorization_attachment.sql',
  ),
  'utf8',
)

async function postedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  transactionId: string
  settlementAccount?: string
  amount?: number
  direction?: 'debit' | 'credit'
  category?: string
  isBusiness?: boolean
}): Promise<string> {
  const journalEntryId = await insertDraftJournalEntry({
    ...params,
    sourceType: 'bank_transaction',
    sourceId: params.transactionId,
    categorizationCategory: params.category ?? 'expense_bank_fees',
    categorizationIsBusiness: params.isBusiness ?? true,
    status: 'draft',
    voucherNumber: Math.floor(Math.random() * 100000) + 1,
  })
  const amount = params.amount ?? 100
  const direction = params.direction ?? 'credit'
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, $2, $3, $4),
            ($1, '6570', $4, $3)`,
    [
      journalEntryId,
      params.settlementAccount ?? '1930',
      direction === 'debit' ? amount : 0,
      direction === 'credit' ? amount : 0,
    ],
  )
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [journalEntryId],
  )
  return journalEntryId
}

async function readTransaction(transactionId: string) {
  const { rows } = await getPool().query<{
    journal_entry_id: string | null
    cash_account_id: string | null
    category: string | null
    is_business: boolean | null
  }>(
    `SELECT journal_entry_id, cash_account_id, category, is_business
       FROM public.transactions
      WHERE id = $1`,
    [transactionId],
  )
  return rows[0]
}

describe('attach_transaction_categorization', () => {
  it('converges when the attachment migration is applied twice', async () => {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(ATTACHMENT_MIGRATION_SQL)
      await client.query(ATTACHMENT_MIGRATION_SQL)

      const { rows } = await client.query<{ columns: string; constraints: string }>(`
        SELECT
          (
            SELECT count(*)::text
              FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'journal_entries'
               AND column_name IN (
                 'categorization_category',
                 'categorization_is_business'
               )
          ) AS columns,
          (
            SELECT count(*)::text
              FROM pg_constraint
             WHERE conrelid = 'public.journal_entries'::regclass
               AND conname = 'journal_entries_categorization_metadata_coherent'
          ) AS constraints
      `)

      expect(rows[0]).toEqual({ columns: '2', constraints: '1' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('attaches only when company, pointer, cash account, and ledger mapping match', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId,
      ledgerAccount: '1931',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      cashAccountId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId, settlementAccount: '1931' })

    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      cashAccountId,
      '1931',
      true,
      'expense_bank_fees',
      journalEntryId,
    ])

    expect(rows[0]?.attached).toBe(true)
    expect(await readTransaction(transactionId)).toMatchObject({
      journal_entry_id: journalEntryId,
      cash_account_id: cashAccountId,
      category: 'expense_bank_fees',
      is_business: true,
    })
  })

  it('rejects a same-id ledger remap that committed before attachment', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId,
      ledgerAccount: '1931',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      cashAccountId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId, settlementAccount: '1931' })

    await getPool().query(
      `UPDATE public.cash_accounts SET ledger_account = '1932' WHERE id = $1`,
      [cashAccountId],
    )
    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      cashAccountId,
      '1931',
      true,
      'expense_bank_fees',
      journalEntryId,
    ])

    expect(rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('holds a cash-account row lock until the attachment transaction ends', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId,
      ledgerAccount: '1931',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      cashAccountId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId, settlementAccount: '1931' })
    const attaching = await getPool().connect()
    const remapping = await getPool().connect()

    try {
      await attaching.query('BEGIN')
      const { rows } = await attaching.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        cashAccountId,
        '1931',
        true,
        'expense_bank_fees',
        journalEntryId,
      ])
      expect(rows[0]?.attached).toBe(true)

      await remapping.query('BEGIN')
      await remapping.query(`SET LOCAL lock_timeout = '100ms'`)
      await expect(
        remapping.query(
          `UPDATE public.cash_accounts SET ledger_account = '1932' WHERE id = $1`,
          [cashAccountId],
        ),
      ).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await remapping.query('ROLLBACK').catch(() => {})
      await attaching.query('ROLLBACK').catch(() => {})
      remapping.release()
      attaching.release()
    }
  })

  it('allows only null cash-account provenance paired with legacy 1930', async () => {
    const company = await seedCompany()
    const wrongTransactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const validTransactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId: validTransactionId })

    const wrong = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      wrongTransactionId,
      null,
      null,
      '1931',
      true,
      'expense_bank_fees',
      journalEntryId,
    ])
    const valid = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      validTransactionId,
      null,
      null,
      '1930',
      true,
      'expense_bank_fees',
      journalEntryId,
    ])

    expect(wrong.rows[0]?.attached).toBe(false)
    expect(valid.rows[0]?.attached).toBe(true)
  })

  it('rejects a posted journal whose actual settlement leg uses the wrong account', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId,
      ledgerAccount: '1931',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      cashAccountId,
    })
    const wrongJournalEntryId = await postedEntry({ ...company, transactionId })

    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      cashAccountId,
      '1931',
      true,
      'expense_bank_fees',
      wrongJournalEntryId,
    ])

    expect(rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('rejects a same-company journal with matching account and amount but a different source transaction', async () => {
    const company = await seedCompany()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const otherTransactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const unrelatedEntryId = await postedEntry({
      ...company,
      transactionId: otherTransactionId,
    })

    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      null,
      '1930',
      true,
      'expense_bank_fees',
      unrelatedEntryId,
    ])

    expect(rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('rejects direct authenticated category or business reinterpretation of durable journal metadata', async () => {
    const company = await seedCompany()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId })

    const wrongCategory = await withUserContext(company.userId, async (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        false,
        'private',
        journalEntryId,
      ]),
    )
    const incoherentFlag = await withUserContext(company.userId, async (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        false,
        'expense_bank_fees',
        journalEntryId,
      ]),
    )

    expect(wrongCategory.rows[0]?.attached).toBe(false)
    expect(incoherentFlag.rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('requires the correct settlement direction', async () => {
    const company = await seedCompany()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      amount: -100,
    })
    const wrongDirectionEntryId = await postedEntry({ ...company, transactionId, direction: 'debit' })

    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      null,
      '1930',
      true,
      'expense_bank_fees',
      wrongDirectionEntryId,
    ])

    expect(rows[0]?.attached).toBe(false)
  })

  it('uses amount_sek ahead of exchange_rate for a foreign transaction', async () => {
    const company = await seedCompany()
    const cashAccountId = await insertCashAccount({
      companyId: company.companyId,
      ledgerAccount: '1940',
      currency: 'EUR',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
      cashAccountId,
      currency: 'EUR',
      amount: -100,
      amountSek: -1150,
      exchangeRate: 99,
    })
    const journalEntryId = await postedEntry({
      ...company,
      transactionId,
      settlementAccount: '1940',
      amount: 1150,
    })

    const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
      company.companyId,
      transactionId,
      null,
      cashAccountId,
      '1940',
      true,
      'expense_bank_fees',
      journalEntryId,
    ])

    expect(rows[0]?.attached).toBe(true)
  })

  it('fails closed for missing, cross-company, and mismatched rows', async () => {
    const companyA = await seedCompany()
    const companyB = await seedCompany()
    const cashA = await insertCashAccount({ companyId: companyA.companyId, ledgerAccount: '1931' })
    const cashB = await insertCashAccount({ companyId: companyB.companyId, ledgerAccount: '1932' })
    const transactionA = await insertTransaction({
      companyId: companyA.companyId,
      userId: companyA.userId,
      cashAccountId: cashA,
    })
    const crossCashTransaction = await insertTransaction({
      companyId: companyA.companyId,
      userId: companyA.userId,
      cashAccountId: cashA,
    })
    await getPool().query(
      `UPDATE public.transactions SET cash_account_id = $1 WHERE id = $2`,
      [cashB, crossCashTransaction],
    )
    const journalEntryA = await postedEntry({
      ...companyA,
      transactionId: transactionA,
      settlementAccount: '1931',
    })

    const probes = [
      [companyA.companyId, randomUUID(), null, cashA, '1931'],
      [companyB.companyId, transactionA, null, cashA, '1931'],
      [companyA.companyId, transactionA, null, cashA, '1930'],
      [companyA.companyId, crossCashTransaction, null, cashB, '1932'],
    ]
    for (const probe of probes) {
      const { rows } = await getPool().query<{ attached: boolean }>(ATTACH_SQL, [
        ...probe,
        true,
        'expense_bank_fees',
        journalEntryA,
      ])
      expect(rows[0]?.attached).toBe(false)
    }
  })

  it('uses invoker RLS for authenticated callers', async () => {
    const companyA = await seedCompany()
    const companyB = await seedCompany()
    const cashA = await insertCashAccount({ companyId: companyA.companyId, ledgerAccount: '1931' })
    const transactionA = await insertTransaction({
      companyId: companyA.companyId,
      userId: companyA.userId,
      cashAccountId: cashA,
    })
    const journalEntryA = await postedEntry({
      ...companyA,
      transactionId: transactionA,
      settlementAccount: '1931',
    })

    const own = await withUserContext(companyA.userId, async (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        companyA.companyId,
        transactionA,
        null,
        cashA,
        '1931',
        true,
        'expense_bank_fees',
        journalEntryA,
      ]),
    )
    expect(own.rows[0]?.attached).toBe(true)

    const cross = await withUserContext(companyB.userId, async (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        companyA.companyId,
        transactionA,
        null,
        cashA,
        '1931',
        true,
        'expense_bank_fees',
        journalEntryA,
      ]),
    )
    expect(cross.rows[0]?.attached).toBe(false)
  })

  it('allows an ordinary company member to attach categorization', async () => {
    const company = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: memberId,
      role: 'member',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId })

    const { result, readback } = await withUserContext(memberId, async (client) => {
      const result = await client.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        journalEntryId,
      ])
      const readback = await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id
           FROM public.transactions
          WHERE id = $1`,
        [transactionId],
      )
      return { result, readback }
    })

    expect(result.rows[0]?.attached).toBe(true)
    expect(readback.rows[0]?.journal_entry_id).toBe(
      journalEntryId,
    )
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('returns false for a viewer without mutating categorization', async () => {
    const company = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: viewerId,
      role: 'viewer',
    })
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId })

    const result = await withUserContext(viewerId, (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        journalEntryId,
      ]),
    )

    expect(result.rows[0]?.attached).toBe(false)
    expect(await readTransaction(transactionId)).toMatchObject({
      journal_entry_id: null,
      category: 'uncategorized',
      is_business: null,
    })
  })

  it('returns false for an authenticated caller with no company memberships', async () => {
    const company = await seedCompany()
    const strangerId = await insertAuthUser()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId })

    const result = await withUserContext(strangerId, (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        journalEntryId,
      ]),
    )

    expect(result.rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('returns false for a NULL company from an authenticated caller', async () => {
    const company = await seedCompany()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const journalEntryId = await postedEntry({ ...company, transactionId })

    const result = await withUserContext(company.userId, (client) =>
      client.query<{ attached: boolean }>(ATTACH_SQL, [
        null,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        journalEntryId,
      ]),
    )

    expect(result.rows[0]?.attached).toBe(false)
    expect((await readTransaction(transactionId))?.journal_entry_id).toBeNull()
  })

  it('allows only one concurrent attachment to claim an unbound transaction', async () => {
    const company = await seedCompany()
    const transactionId = await insertTransaction({
      companyId: company.companyId,
      userId: company.userId,
    })
    const firstEntryId = await postedEntry({ ...company, transactionId })
    const secondEntryId = await postedEntry({ ...company, transactionId })
    const first = await getPool().connect()
    const second = await getPool().connect()

    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      const firstResult = await first.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        firstEntryId,
      ])
      const secondResultPromise = second.query<{ attached: boolean }>(ATTACH_SQL, [
        company.companyId,
        transactionId,
        null,
        null,
        '1930',
        true,
        'expense_bank_fees',
        secondEntryId,
      ])

      await first.query('COMMIT')
      const secondResult = await secondResultPromise
      await second.query('COMMIT')

      expect(firstResult.rows[0]?.attached).toBe(true)
      expect(secondResult.rows[0]?.attached).toBe(false)
      expect((await readTransaction(transactionId))?.journal_entry_id).toBe(firstEntryId)
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
  })
})
