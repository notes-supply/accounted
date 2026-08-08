import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'
import { getPool, withUserContext } from './setup'

const COMPENSATE_SQL = `
  SELECT public.compensate_transaction_categorization($1, $2, $3) AS result
`

interface CompensationResult {
  status: string
  original_journal_entry_id: string
  reversal_journal_entry_ids: string[]
  original_pointer_cleared: boolean
}

async function seedCategorizedVoucher(options: {
  attachPointer?: boolean
  duplicateOriginalLines?: boolean
} = {}) {
  const company = await seedCompany()
  const transactionId = await insertTransaction({
    companyId: company.companyId,
    userId: company.userId,
    amount: -100,
  })
  const originalId = await insertDraftJournalEntry({
    ...company,
    sourceType: 'bank_transaction',
    sourceId: transactionId,
    categorizationCategory: 'expense_bank_fees',
    categorizationIsBusiness: true,
  })
  if (options.duplicateOriginalLines) {
    await insertBalancedLines(originalId, 50)
    await insertBalancedLines(originalId, 50)
  } else {
    await insertBalancedLines(originalId, 100)
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [originalId],
  )
  if (options.attachPointer !== false) {
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $1 WHERE id = $2`,
      [originalId, transactionId],
    )
  }
  return { ...company, transactionId, originalId }
}

interface ReversalLine {
  accountNumber: string
  debit: number
  credit: number
  taxCode?: string | null
  dimensions?: Record<string, string>
}

async function insertExistingReversal(
  seeded: Awaited<ReturnType<typeof seedCategorizedVoucher>>,
  lines: ReversalLine[],
): Promise<string> {
  const reversalId = await insertDraftJournalEntry({
    userId: seeded.userId,
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
    sourceType: 'storno',
    sourceId: seeded.transactionId,
  })
  await getPool().query(
    `UPDATE public.journal_entries SET reverses_id = $1 WHERE id = $2`,
    [seeded.originalId, reversalId],
  )
  for (const line of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount,
          tax_code, dimensions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        reversalId,
        line.accountNumber,
        line.debit,
        line.credit,
        line.taxCode ?? null,
        JSON.stringify(line.dimensions ?? {}),
      ],
    )
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [reversalId],
  )
  return reversalId
}

async function readCompensationRows(originalId: string) {
  const original = await getPool().query<{
    status: string
    reversed_by_id: string | null
  }>(
    `SELECT status, reversed_by_id FROM public.journal_entries WHERE id = $1`,
    [originalId],
  )
  const reversals = await getPool().query<{
    id: string
    status: string
    reverses_id: string
  }>(
    `SELECT id, status, reverses_id
       FROM public.journal_entries
      WHERE reverses_id = $1
      ORDER BY created_at, id`,
    [originalId],
  )
  return { original: original.rows[0], reversals: reversals.rows }
}

describe('compensate_transaction_categorization', () => {
  it('atomically posts one storno, legally reverses the original, and clears its pointer', async () => {
    const seeded = await seedCategorizedVoucher()

    const { rows } = await getPool().query<{ result: CompensationResult }>(
      COMPENSATE_SQL,
      [seeded.companyId, seeded.transactionId, seeded.originalId],
    )
    const result = rows[0]!.result
    const state = await readCompensationRows(seeded.originalId)
    const pointer = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
      [seeded.transactionId],
    )

    expect(result).toMatchObject({
      status: 'reversed',
      original_journal_entry_id: seeded.originalId,
      original_pointer_cleared: true,
    })
    expect(result.reversal_journal_entry_ids).toHaveLength(1)
    expect(state.original).toEqual({
      status: 'reversed',
      reversed_by_id: result.reversal_journal_entry_ids[0],
    })
    expect(state.reversals).toEqual([
      {
        id: result.reversal_journal_entry_ids[0],
        status: 'posted',
        reverses_id: seeded.originalId,
      },
    ])
    expect(pointer.rows[0]?.journal_entry_id).toBeNull()

    const reversedLines = await getPool().query<{
      account_number: string
      debit_amount: string
      credit_amount: string
    }>(
      `SELECT account_number, debit_amount, credit_amount
         FROM public.journal_entry_lines
        WHERE journal_entry_id = $1
        ORDER BY account_number`,
      [result.reversal_journal_entry_ids[0]],
    )
    expect(
      reversedLines.rows.map((line) => ({
        ...line,
        debit_amount: Number(line.debit_amount),
        credit_amount: Number(line.credit_amount),
      })),
    ).toEqual([
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      { account_number: '3001', debit_amount: 100, credit_amount: 0 },
    ])
  })

  it('returns the same authoritative reversal to two concurrent callers', async () => {
    const seeded = await seedCategorizedVoucher()
    const first = await getPool().connect()
    const second = await getPool().connect()

    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      const firstResult = await first.query<{ result: CompensationResult }>(
        COMPENSATE_SQL,
        [seeded.companyId, seeded.transactionId, seeded.originalId],
      )
      const secondPromise = second.query<{ result: CompensationResult }>(
        COMPENSATE_SQL,
        [seeded.companyId, seeded.transactionId, seeded.originalId],
      )

      await first.query('COMMIT')
      const secondResult = await secondPromise
      await second.query('COMMIT')

      expect(firstResult.rows[0]?.result.status).toBe('reversed')
      expect(secondResult.rows[0]?.result.status).toBe('already_reversed')
      expect(secondResult.rows[0]?.result.reversal_journal_entry_ids).toEqual(
        firstResult.rows[0]?.result.reversal_journal_entry_ids,
      )
      expect((await readCompensationRows(seeded.originalId)).reversals).toHaveLength(1)
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
  })

  it('adopts one authoritative existing posted reversal without creating another', async () => {
    const seeded = await seedCategorizedVoucher()
    const existingReversalId = await insertExistingReversal(seeded, [
      { accountNumber: '1930', debit: 0, credit: 100 },
      { accountNumber: '3001', debit: 100, credit: 0 },
    ])

    const { rows } = await getPool().query<{ result: CompensationResult }>(
      COMPENSATE_SQL,
      [seeded.companyId, seeded.transactionId, seeded.originalId],
    )

    expect(rows[0]?.result).toMatchObject({
      status: 'recovered_existing_reversal',
      reversal_journal_entry_ids: [existingReversalId],
      original_pointer_cleared: true,
    })
    expect((await readCompensationRows(seeded.originalId)).reversals).toHaveLength(1)
  })

  it.each([
    {
      name: 'wrong account',
      lines: [
        { accountNumber: '1940', debit: 0, credit: 100 },
        { accountNumber: '3001', debit: 100, credit: 0 },
      ],
    },
    {
      name: 'wrong amount',
      lines: [
        { accountNumber: '1930', debit: 0, credit: 99 },
        { accountNumber: '3001', debit: 99, credit: 0 },
      ],
    },
    {
      name: 'wrong direction',
      lines: [
        { accountNumber: '1930', debit: 100, credit: 0 },
        { accountNumber: '3001', debit: 0, credit: 100 },
      ],
    },
    {
      name: 'wrong tax code',
      lines: [
        { accountNumber: '1930', debit: 0, credit: 100, taxCode: '48' },
        { accountNumber: '3001', debit: 100, credit: 0 },
      ],
    },
    {
      name: 'wrong dimensions',
      lines: [
        { accountNumber: '1930', debit: 0, credit: 100, dimensions: { '1': 'KS01' } },
        { accountNumber: '3001', debit: 100, credit: 0 },
      ],
    },
    {
      name: 'missing duplicate multiplicity',
      duplicateOriginalLines: true,
      lines: [
        { accountNumber: '1930', debit: 0, credit: 50 },
        { accountNumber: '3001', debit: 50, credit: 0 },
      ],
    },
    {
      name: 'extra duplicate multiplicity',
      lines: [
        { accountNumber: '1930', debit: 0, credit: 100 },
        { accountNumber: '1930', debit: 0, credit: 100 },
        { accountNumber: '3001', debit: 100, credit: 0 },
        { accountNumber: '3001', debit: 100, credit: 0 },
      ],
    },
  ])('refuses to adopt an existing posted reversal with $name', async (testCase) => {
    const seeded = await seedCategorizedVoucher({
      duplicateOriginalLines: testCase.duplicateOriginalLines ?? false,
    })
    const existingReversalId = await insertExistingReversal(seeded, testCase.lines)

    const { rows } = await getPool().query<{ result: CompensationResult }>(
      COMPENSATE_SQL,
      [seeded.companyId, seeded.transactionId, seeded.originalId],
    )
    const state = await readCompensationRows(seeded.originalId)
    const pointer = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
      [seeded.transactionId],
    )

    expect(rows[0]?.result).toEqual({
      status: 'unverified_existing_reversal',
      original_journal_entry_id: seeded.originalId,
      reversal_journal_entry_ids: [existingReversalId],
      original_pointer_cleared: false,
    })
    expect(state.original).toEqual({ status: 'posted', reversed_by_id: null })
    expect(state.reversals).toEqual([
      {
        id: existingReversalId,
        status: 'posted',
        reverses_id: seeded.originalId,
      },
    ])
    expect(pointer.rows[0]?.journal_entry_id).toBe(seeded.originalId)
  })

  it('rolls back every attempted storno artifact when posting is blocked', async () => {
    const seeded = await seedCategorizedVoucher()
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET is_closed = true, closed_at = now()
        WHERE id = $1`,
      [seeded.fiscalPeriodId],
    )

    await expect(
      getPool().query(COMPENSATE_SQL, [
        seeded.companyId,
        seeded.transactionId,
        seeded.originalId,
      ]),
    ).rejects.toThrow(/locked|closed/i)

    const state = await readCompensationRows(seeded.originalId)
    expect(state.original).toEqual({ status: 'posted', reversed_by_id: null })
    expect(state.reversals).toEqual([])
  })

  it('rejects a cross-company authenticated caller without changing the original', async () => {
    const seeded = await seedCategorizedVoucher()
    const other = await seedCompany()

    await expect(
      withUserContext(other.userId, (client) =>
        client.query(COMPENSATE_SQL, [
          seeded.companyId,
          seeded.transactionId,
          seeded.originalId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect((await readCompensationRows(seeded.originalId)).original?.status).toBe('posted')
  })

  it('allows an ordinary company member to compensate categorization', async () => {
    const seeded = await seedCategorizedVoucher()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seeded.companyId,
      userId: memberId,
      role: 'member',
    })

    const { rows } = await withUserContext(memberId, (client) =>
      client.query<{ result: CompensationResult }>(COMPENSATE_SQL, [
        seeded.companyId,
        seeded.transactionId,
        seeded.originalId,
      ]),
    )

    expect(rows[0]?.result.status).toBe('reversed')
    expect(rows[0]?.result.original_journal_entry_id).toBe(seeded.originalId)
  })

  it('rejects a viewer without changing the original', async () => {
    const seeded = await seedCategorizedVoucher()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seeded.companyId,
      userId: viewerId,
      role: 'viewer',
    })

    await expect(
      withUserContext(viewerId, (client) =>
        client.query(COMPENSATE_SQL, [
          seeded.companyId,
          seeded.transactionId,
          seeded.originalId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect((await readCompensationRows(seeded.originalId)).original?.status).toBe(
      'posted',
    )
  })

  it('rejects an authenticated caller with no company memberships', async () => {
    const seeded = await seedCategorizedVoucher()
    const strangerId = await insertAuthUser()

    await expect(
      withUserContext(strangerId, (client) =>
        client.query(COMPENSATE_SQL, [
          seeded.companyId,
          seeded.transactionId,
          seeded.originalId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect((await readCompensationRows(seeded.originalId)).original?.status).toBe('posted')
  })

  it('rejects a NULL company from an authenticated caller', async () => {
    const seeded = await seedCategorizedVoucher()

    await expect(
      withUserContext(seeded.userId, (client) =>
        client.query(COMPENSATE_SQL, [
          null,
          seeded.transactionId,
          seeded.originalId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    expect((await readCompensationRows(seeded.originalId)).original?.status).toBe('posted')
  })
})
