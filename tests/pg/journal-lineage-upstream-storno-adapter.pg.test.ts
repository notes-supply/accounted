import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from './fixtures'
import { getPool } from './setup'

interface Tenant {
  userId: string
  companyId: string
  fiscalPeriodId: string
}

interface Line {
  account: string
  debit: number
  credit: number
}

async function createChildDraftAcrossTransactions(
  tenant: Tenant,
  input: {
    kind: 'storno' | 'correction'
    originalId: string
    voucherNumber: number
    lines: Line[]
  },
): Promise<string> {
  const id = randomUUID()
  const pool = getPool()

  // These are deliberately separate auto-committed statements. They reproduce
  // the PostgREST transaction boundaries in upstream correctEntry(): header,
  // lines, and publication do not share one database transaction.
  await pool.query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status,
       correction_of_id, reverses_id
     ) VALUES (
       $1, $2, $3, $4, $5, 'A', '2026-05-31', $6, $7, 'draft',
       CASE WHEN $7 = 'correction' THEN $8::uuid ELSE NULL END,
       CASE WHEN $7 = 'storno' THEN $8::uuid ELSE NULL END
     )`,
    [
      id,
      tenant.userId,
      tenant.companyId,
      tenant.fiscalPeriodId,
      input.voucherNumber,
      input.kind === 'storno' ? 'Storno: Anthropic A12' : 'Rättelse: Anthropic A12',
      input.kind,
      input.originalId,
    ],
  )

  for (const [sortOrder, line] of input.lines.entries()) {
    await pool.query(
      `INSERT INTO public.journal_entry_lines (
         journal_entry_id, account_number, debit_amount, credit_amount, sort_order
       ) VALUES ($1, $2, $3, $4, $5)`,
      [id, line.account, line.debit, line.credit, sortOrder],
    )
  }
  return id
}

async function publishChildAcrossTransactions(
  tenant: Tenant,
  input: {
    kind: 'storno' | 'correction'
    originalId: string
    voucherNumber: number
    lines: Line[]
  },
): Promise<string> {
  const id = await createChildDraftAcrossTransactions(tenant, input)
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
    [id],
  )
  return id
}

async function lineageIsValid(client: PoolClient, entryId: string): Promise<boolean> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT public.journal_lineage_final_state_is_valid($1) AS valid`,
    [entryId],
  )
  return result.rows[0]!.valid
}

async function insertPostedEntryWithoutProvenance(
  tenant: Tenant,
  lines: Line[],
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries (
         id, user_id, company_id, fiscal_period_id, voucher_number,
         voucher_series, entry_date, description, source_type, status,
         committed_at
       ) VALUES ($1, $2, $3, $4, 21, 'A', '2026-05-31',
                 'Invalid provenance fixture', 'manual', 'posted', NULL)`,
      [id, tenant.userId, tenant.companyId, tenant.fiscalPeriodId],
    )
    for (const [sortOrder, line] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (
           journal_entry_id, account_number, debit_amount, credit_amount, sort_order
         ) VALUES ($1, $2, $3, $4, $5)`,
        [id, line.account, line.debit, line.credit, sortOrder],
      )
    }
    await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const ORIGINAL_A12: Line[] = [
  { account: '5420', debit: 919.2, credit: 0 },
  { account: '2645', debit: 229.8, credit: 0 },
  { account: '2614', debit: 0, credit: 229.8 },
  { account: '1930', debit: 0, credit: 919.2 },
]

const STORNO_A12: Line[] = ORIGINAL_A12.map((line) => ({
  account: line.account,
  debit: line.credit,
  credit: line.debit,
}))

const CORRECTED_A12: Line[] = ORIGINAL_A12.map((line) =>
  line.account === '1930' ? { ...line, account: '1931' } : line,
)

describe('upstream storno transaction-boundary adapter', () => {
  it('keeps deferred all-row and edge enforcement with parent locking', async () => {
    const result = await getPool().query<{ name: string }>(`
      SELECT tgname AS name
      FROM pg_trigger
      WHERE tgrelid = 'public.journal_entries'::regclass
        AND NOT tgisinternal
    `)
    const names = new Set(result.rows.map((row) => row.name))

    expect(names).toContain('validate_journal_lineage_edge')
    expect(names).toContain('lock_journal_lineage_parents')
    expect(names).toContain('validate_journal_lineage_final_state')
    expect(names).not.toContain('validate_journal_lineage_completion')

    const functions = await getPool().query<{
      name: string
      security_definer: boolean
      config: string[] | null
      public_execute: boolean
      anon_execute: boolean
      authenticated_execute: boolean
      service_role_execute: boolean
    }>(`
      SELECT
        procedure.proname AS name,
        procedure.prosecdef AS security_definer,
        procedure.proconfig AS config,
        has_function_privilege('public', procedure.oid, 'EXECUTE') AS public_execute,
        has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_role_execute
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'journal_lineage_state_is_valid',
          'lock_journal_lineage_parents',
          'validate_journal_lineage_final_state'
        )
      ORDER BY procedure.proname
    `)

    expect(functions.rows).toHaveLength(3)
    for (const fn of functions.rows) {
      expect(fn.security_definer).toBe(true)
      expect(fn.config).toContain('search_path=pg_catalog, public')
      expect(fn.public_execute).toBe(false)
      expect(fn.anon_execute).toBe(false)
      expect(fn.authenticated_execute).toBe(false)
      expect(fn.service_role_execute).toBe(false)
    }
  })

  it('publishes the A12 storno and replacement over upstream transaction boundaries', async () => {
    const tenant = await seedCompany()
    const originalId = await insertPostedJournalEntry({
      ...tenant,
      entryDate: '2026-05-31',
      voucherNumber: 12,
      description: 'Anthropic A12',
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })

    const reversalId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId,
      voucherNumber: 13,
      lines: STORNO_A12,
    })

    // The residual upstream risk is explicit: the first committed child alone
    // is not a complete correction graph, but it no longer aborts publication.
    const client = await getPool().connect()
    try {
      expect(await lineageIsValid(client, originalId)).toBe(false)
    } finally {
      client.release()
    }

    const correctedId = await publishChildAcrossTransactions(tenant, {
      kind: 'correction',
      originalId,
      voucherNumber: 14,
      lines: CORRECTED_A12,
    })

    await getPool().query(
      `UPDATE public.journal_entries
       SET status = 'reversed', reversed_by_id = $2
       WHERE id = $1`,
      [originalId, reversalId],
    )

    const final = await getPool().query<{
      id: string
      status: string
      source_type: string
      reverses_id: string | null
      correction_of_id: string | null
      reversed_by_id: string | null
      valid: boolean
    }>(
      `SELECT
         entry.id,
         entry.status,
         entry.source_type,
         entry.reverses_id,
         entry.correction_of_id,
         entry.reversed_by_id,
         public.journal_lineage_final_state_is_valid(entry.id) AS valid
       FROM public.journal_entries entry
       WHERE entry.id = ANY($1::uuid[])
       ORDER BY entry.id`,
      [[originalId, reversalId, correctedId]],
    )

    expect(final.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: originalId,
        status: 'reversed',
        reversed_by_id: reversalId,
        valid: true,
      }),
      expect.objectContaining({
        id: reversalId,
        status: 'posted',
        source_type: 'storno',
        reverses_id: originalId,
        valid: true,
      }),
      expect.objectContaining({
        id: correctedId,
        status: 'posted',
        source_type: 'correction',
        correction_of_id: originalId,
        valid: true,
      }),
    ]))

    const correctedCash = await getPool().query<{
      account_number: string
      credit_amount: string
    }>(
      `SELECT account_number, credit_amount::text
       FROM public.journal_entry_lines
       WHERE journal_entry_id = $1
         AND credit_amount > 0
       ORDER BY account_number`,
      [correctedId],
    )
    expect(correctedCash.rows.map((row) => ({
      account_number: row.account_number,
      credit_amount: Number(row.credit_amount),
    }))).toContainEqual({
      account_number: '1931',
      credit_amount: 919.2,
    })
    expect(correctedCash.rows).not.toContainEqual(expect.objectContaining({
      account_number: '1930',
    }))

    const accountNet = await getPool().query<{
      account_number: string
      net: string
    }>(
      `SELECT
         account_number,
         sum(debit_amount - credit_amount)::text AS net
       FROM public.journal_entry_lines
       WHERE journal_entry_id = ANY($1::uuid[])
         AND account_number IN ('1930', '1931')
       GROUP BY account_number
       ORDER BY account_number`,
      [[originalId, reversalId, correctedId]],
    )
    expect(accountNet.rows.map((row) => ({
      account_number: row.account_number,
      net: Number(row.net),
    }))).toEqual([
      { account_number: '1930', net: 0 },
      { account_number: '1931', net: -919.2 },
    ])

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
        [correctedId],
      ),
    ).rejects.toThrow(/finalized correction child cannot be cancelled or deleted/i)

    // A later correction generation is valid after its ancestor has reached
    // the complete reversed state.
    const secondStornoId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId: correctedId,
      voucherNumber: 15,
      lines: CORRECTED_A12.map((line) => ({
        account: line.account,
        debit: line.credit,
        credit: line.debit,
      })),
    })
    await publishChildAcrossTransactions(tenant, {
      kind: 'correction',
      originalId: correctedId,
      voucherNumber: 16,
      lines: CORRECTED_A12,
    })
    await getPool().query(
      `UPDATE public.journal_entries
       SET status = 'reversed', reversed_by_id = $2
       WHERE id = $1`,
      [correctedId, secondStornoId],
    )
    const chain = await getPool().query<{ id: string; valid: boolean }>(
      `SELECT id, public.journal_lineage_final_state_is_valid(id) AS valid
       FROM public.journal_entries
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[originalId, correctedId]],
    )
    expect(chain.rows).toEqual([
      { id: originalId, valid: true },
      { id: correctedId, valid: true },
    ].sort((left, right) => left.id.localeCompare(right.id)))
  })

  it('rejects a direct posted insert without committed provenance', async () => {
    const tenant = await seedCompany()
    await expect(
      insertPostedEntryWithoutProvenance(tenant, ORIGINAL_A12),
    ).rejects.toThrow(/journal lineage state is contradictory/i)
  })

  it('rejects a second staged generation below an unfinished ancestor', async () => {
    const tenant = await seedCompany()
    const rootId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 25,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const firstCorrectionId = await publishChildAcrossTransactions(tenant, {
      kind: 'correction',
      originalId: rootId,
      voucherNumber: 26,
      lines: CORRECTED_A12,
    })

    await expect(
      publishChildAcrossTransactions(tenant, {
        kind: 'correction',
        originalId: firstCorrectionId,
        voucherNumber: 27,
        lines: CORRECTED_A12,
      }),
    ).rejects.toThrow(/journal lineage state is contradictory/i)
  })

  it('admits a nested generation only after concurrent ancestor finalization commits', async () => {
    const tenant = await seedCompany()
    const rootId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 28,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const rootStornoId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId: rootId,
      voucherNumber: 29,
      lines: STORNO_A12,
    })
    const firstCorrectionId = await publishChildAcrossTransactions(tenant, {
      kind: 'correction',
      originalId: rootId,
      voucherNumber: 30,
      lines: CORRECTED_A12,
    })
    const nestedDraftId = await createChildDraftAcrossTransactions(tenant, {
      kind: 'correction',
      originalId: firstCorrectionId,
      voucherNumber: 31,
      lines: CORRECTED_A12,
    })
    const finalizer = await getPool().connect()
    const publisher = await getPool().connect()

    try {
      await finalizer.query('BEGIN')
      const publisherPid = (await publisher.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid
      await finalizer.query(
        `UPDATE public.journal_entries
         SET status = 'reversed', reversed_by_id = $2
         WHERE id = $1`,
        [rootId, rootStornoId],
      )

      let publicationSettled = false
      const nestedPublication = publisher
        .query(
          `UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`,
          [nestedDraftId],
        )
        .finally(() => {
          publicationSettled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(publicationSettled).toBe(false)
      const waitState = await getPool().query<{
        state: string
        wait_event_type: string | null
      }>(
        `SELECT state, wait_event_type
         FROM pg_stat_activity
         WHERE pid = $1`,
        [publisherPid],
      )
      expect(waitState.rows[0]).toMatchObject({
        state: 'active',
        wait_event_type: 'Lock',
      })

      await finalizer.query('COMMIT')
      await nestedPublication
      await getPool().query(
        `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
        [nestedDraftId],
      )
    } finally {
      await finalizer.query('ROLLBACK').catch(() => {})
      finalizer.release()
      publisher.release()
    }
  })

  it('finalizes a legitimate storno-only reversal across transactions', async () => {
    const tenant = await seedCompany()
    const originalId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 31,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const reversalId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId,
      voucherNumber: 32,
      lines: STORNO_A12,
    })

    await getPool().query(
      `UPDATE public.journal_entries
       SET status = 'reversed', reversed_by_id = $2
       WHERE id = $1`,
      [originalId, reversalId],
    )

    const result = await getPool().query<{ valid: boolean }>(
      `SELECT public.journal_lineage_final_state_is_valid($1) AS valid`,
      [originalId],
    )
    expect(result.rows[0]).toEqual({ valid: true })
  })

  it('allows cleanup while the parent is posted but preserves a finalized graph', async () => {
    const tenant = await seedCompany()
    const cleanupOriginalId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 41,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const cleanupStornoId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId: cleanupOriginalId,
      voucherNumber: 42,
      lines: STORNO_A12,
    })

    await getPool().query(
      `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
      [cleanupStornoId],
    )

    const finalOriginalId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 43,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const finalStornoId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId: finalOriginalId,
      voucherNumber: 44,
      lines: STORNO_A12,
    })
    await getPool().query(
      `UPDATE public.journal_entries
       SET status = 'reversed', reversed_by_id = $2
       WHERE id = $1`,
      [finalOriginalId, finalStornoId],
    )

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
        [finalStornoId],
      ),
    ).rejects.toThrow(/journal lineage state is contradictory/i)
  })

  it('serializes finalization against concurrent correction cancellation', async () => {
    const tenant = await seedCompany()
    const originalId = await insertPostedJournalEntry({
      ...tenant,
      voucherNumber: 51,
      committedAt: '2026-05-31T10:00:00Z',
      lines: ORIGINAL_A12.map((line) => ({
        accountNumber: line.account,
        debitAmount: line.debit,
        creditAmount: line.credit,
      })),
    })
    const reversalId = await publishChildAcrossTransactions(tenant, {
      kind: 'storno',
      originalId,
      voucherNumber: 52,
      lines: STORNO_A12,
    })
    const correctionId = await publishChildAcrossTransactions(tenant, {
      kind: 'correction',
      originalId,
      voucherNumber: 53,
      lines: CORRECTED_A12,
    })
    const finalizer = await getPool().connect()
    const canceller = await getPool().connect()

    try {
      await finalizer.query('BEGIN')
      await canceller.query('BEGIN')
      const cancellerPid = (await canceller.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid
      await finalizer.query(
        `UPDATE public.journal_entries
         SET status = 'reversed', reversed_by_id = $2
         WHERE id = $1`,
        [originalId, reversalId],
      )

      const cancellation = canceller.query(
        `UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`,
        [correctionId],
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      const waitState = await getPool().query<{
        state: string
        wait_event_type: string | null
        wait_event: string | null
      }>(
        `SELECT state, wait_event_type, wait_event
         FROM pg_stat_activity
         WHERE pid = $1`,
        [cancellerPid],
      )
      expect(waitState.rows[0]).toMatchObject({
        state: 'active',
        wait_event_type: 'Lock',
        wait_event: 'advisory',
      })

      await finalizer.query('COMMIT')
      await expect(cancellation).rejects.toThrow(/Finalized correction child cannot be cancelled/i)

      const status = await getPool().query<{ status: string }>(
        `SELECT status FROM public.journal_entries WHERE id = $1`,
        [correctionId],
      )
      expect(status.rows[0]?.status).toBe('posted')
    } finally {
      await finalizer.query('ROLLBACK').catch(() => {})
      await canceller.query('ROLLBACK').catch(() => {})
      finalizer.release()
      canceller.release()
    }
  })
})
