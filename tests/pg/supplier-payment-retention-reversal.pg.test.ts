import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'

let arrivalSequence = 900_000
const ALLOCATION_CREATED_AT = '2026-05-15T12:34:56.000Z'

async function seedPaidSupplierPayment(): Promise<{
  userId: string
  companyId: string
  invoiceId: string
  transactionId: string
  fiscalPeriodId: string
  rootEntryId: string
  paymentId: string
}> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const supplierId = randomUUID()
  const invoiceId = randomUUID()
  const paymentId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country,
        default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'WP5 supplier', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, userId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date, received_date,
        status, currency, subtotal, vat_amount, total, paid_amount,
        remaining_amount, paid_at, vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, DATE '2026-05-01', DATE '2026-05-30',
             DATE '2026-05-01', 'paid', 'SEK', 100, 0, 100, 100, 0,
             now(), 'standard_25', false, false)`,
    [invoiceId, userId, companyId, supplierId, arrivalSequence, `WP5-${arrivalSequence++}`],
  )
  const rootEntryId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    voucherNumber: arrivalSequence++,
    entryDate: '2026-05-15',
    description: 'Supplier payment',
    sourceType: 'supplier_invoice_paid',
    committedAt: '2026-05-15T10:00:00.000Z',
    sourceId: invoiceId,
    lines: [
      { accountNumber: '2440', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
    ],
  })
  const transactionId = await insertTransaction({
    companyId,
    userId,
    amount: -100,
    date: '2026-05-15',
    description: 'Supplier payment',
    journalEntryId: rootEntryId,
  })
  await getPool().query(
    `UPDATE public.supplier_invoices
     SET payment_journal_entry_id = $1, transaction_id = $2
     WHERE id = $3`,
    [rootEntryId, transactionId, invoiceId],
  )
  await runAsServiceRole((client) =>
    client.query(
      `INSERT INTO public.supplier_invoice_payments
         (id, user_id, company_id, supplier_invoice_id, payment_date, amount,
          currency, journal_entry_id, transaction_id, notes, created_at)
       VALUES ($1, $2, $3, $4, DATE '2026-05-15', 100, 'SEK', $5, $6,
               'exact allocation', $7::timestamptz)`,
      [
        paymentId,
        userId,
        companyId,
        invoiceId,
        rootEntryId,
        transactionId,
        ALLOCATION_CREATED_AT,
      ],
    ),
  )
  return {
    userId,
    companyId,
    fiscalPeriodId,
    invoiceId,
    transactionId,
    rootEntryId,
    paymentId,
  }
}

async function reverse(
  userId: string,
  companyId: string,
  rootEntryId: string,
  originalEntryId: string,
  reversalDate = '2026-05-16',
): Promise<Record<string, unknown>> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE authenticated`)
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.apply_supplier_payment_reversal(
         $1, $2, $3, $4::date, 'api_key', $5, 'forged label'
       ) AS result`,
      [companyId, rootEntryId, originalEntryId, reversalDate, randomUUID()],
    )
    await client.query('COMMIT')
    return result.rows[0]!.result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function reverseAsService(
  companyId: string,
  rootEntryId: string,
  originalEntryId: string,
  actorLabel: string | null,
  actorType = 'cron',
): Promise<Record<string, unknown>> {
  return runAsServiceRole(async (client) => {
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.apply_supplier_payment_reversal(
         $1, $2, $3, DATE '2026-05-16', $4, $5, $6
       ) AS result`,
      [companyId, rootEntryId, originalEntryId, actorType, randomUUID(), actorLabel],
    )
    return result.rows[0]!.result
  })
}

async function forgeAllocationProvenance(
  paymentId: string,
  forged: { sourceId?: string; userId?: string },
): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = 'replica'`)
    if (forged.sourceId) {
      await client.query(
        `UPDATE public.journal_entries entry
         SET source_id = $2
         FROM public.supplier_invoice_payments allocation
         WHERE allocation.id = $1
           AND entry.id = allocation.journal_entry_id`,
        [paymentId, forged.sourceId],
      )
    }
    if (forged.userId) {
      await client.query(
        `UPDATE public.supplier_invoice_payments
         SET user_id = $2
         WHERE id = $1`,
        [paymentId, forged.userId],
      )
    }
    await client.query(`SET LOCAL session_replication_role = 'origin'`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function addAccountingEquivalentCorrection(
  fixture: Awaited<ReturnType<typeof seedPaidSupplierPayment>>,
): Promise<string> {
  const stornoId = randomUUID()
  const correctionId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries (
         id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
         entry_date, description, source_type, source_id, status, reverses_id,
         committed_at, commit_method
       )
       SELECT $1, user_id, company_id, fiscal_period_id, $2, voucher_series,
              entry_date, 'Prior supplier storno', 'storno', source_id, 'posted',
              id, now(), 'legacy'
       FROM public.journal_entries
       WHERE id = $3`,
      [stornoId, arrivalSequence++, fixture.rootEntryId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (
         journal_entry_id, account_number, debit_amount, credit_amount, currency,
         line_description, amount_in_currency, exchange_rate, sort_order,
         tax_code, dimensions
       )
       SELECT $1, account_number, credit_amount, debit_amount, currency,
              line_description, amount_in_currency, exchange_rate, sort_order,
              tax_code, dimensions
       FROM public.journal_entry_lines
       WHERE journal_entry_id = $2`,
      [stornoId, fixture.rootEntryId],
    )
    await client.query(
      `INSERT INTO public.journal_entries (
         id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
         entry_date, description, source_type, source_id, status, correction_of_id,
         committed_at, commit_method
       )
       SELECT $1, user_id, company_id, fiscal_period_id, $2, voucher_series,
              entry_date, 'Equivalent supplier correction', 'correction', source_id,
              'posted', id, now(), 'legacy'
       FROM public.journal_entries
       WHERE id = $3`,
      [correctionId, arrivalSequence++, fixture.rootEntryId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (
         journal_entry_id, account_number, debit_amount, credit_amount, currency,
         line_description, amount_in_currency, exchange_rate, sort_order,
         tax_code, dimensions
       )
       SELECT $1, account_number, debit_amount, credit_amount, currency,
              line_description, amount_in_currency, exchange_rate, sort_order,
              tax_code, dimensions
       FROM public.journal_entry_lines
       WHERE journal_entry_id = $2`,
      [correctionId, fixture.rootEntryId],
    )
    await client.query(`SET LOCAL session_replication_role = 'replica'`)
    await client.query(
      `UPDATE public.journal_entries
       SET status = 'reversed', reversed_by_id = $2
       WHERE id = $1`,
      [fixture.rootEntryId, stornoId],
    )
    await client.query(`SET LOCAL session_replication_role = 'origin'`)
    await client.query('COMMIT')
    return correctionId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

describe('M3 supplier payment retention and reversal', () => {
  it('moves exact allocations to immutable history and retries by durable identity', async () => {
    const fixture = await seedPaidSupplierPayment()
    const first = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
    )

    expect(first.status).toBe('applied')
    expect(first.root_journal_entry_id).toBe(fixture.rootEntryId)
    expect(first.original_journal_entry_id).toBe(fixture.rootEntryId)
    expect(first.actor_type).toBe('user')
    expect(first.actor_id).toBe(fixture.userId)
    expect(first.actor_label).toBeNull()
    expect(first.publications).toHaveLength(2)

    const reversalId = first.reversal_journal_entry_id as string
    const projections = await getPool().query<{
      original_entry: Record<string, unknown>
      reversal_entry: Record<string, unknown>
    }>(
      `SELECT
         public.accounting_journal_entry_event_object($1, $2) AS original_entry,
         public.accounting_journal_entry_event_object($1, $3) AS reversal_entry`,
      [fixture.companyId, fixture.rootEntryId, reversalId],
    )
    const originalEntry = projections.rows[0]!.original_entry
    const reversalEntry = projections.rows[0]!.reversal_entry
    const publications = await getPool().query<{
      publication_id: string
      publication_key: string
      event_type: string
      entity_id: string
      user_id: string
      payload: Record<string, unknown>
      event_log_sequence: number
    }>(
      `SELECT publication.id::text AS publication_id,
              publication.publication_key,
              publication.event_type,
              publication.entity_id::text,
              publication.user_id::text,
              publication.payload,
              event.sequence::int AS event_log_sequence
       FROM public.accounting_publications publication
       JOIN public.event_log event
         ON event.accounting_publication_id = publication.id
       WHERE publication.publication_key = ANY($1::text[])
       ORDER BY array_position($1::text[], publication.publication_key)`,
      [[
        `journal:${reversalId}:committed`,
        `journal:${fixture.rootEntryId}:reversed`,
      ]],
    )
    expect(publications.rows).toEqual([
      {
        publication_id: expect.any(String),
        publication_key: `journal:${reversalId}:committed`,
        event_type: 'journal_entry.committed',
        entity_id: reversalId,
        user_id: fixture.userId,
        payload: {
          companyId: fixture.companyId,
          userId: fixture.userId,
          entry: reversalEntry,
        },
        event_log_sequence: expect.any(Number),
      },
      {
        publication_id: expect.any(String),
        publication_key: `journal:${fixture.rootEntryId}:reversed`,
        event_type: 'journal_entry.reversed',
        entity_id: reversalId,
        user_id: fixture.userId,
        payload: {
          companyId: fixture.companyId,
          userId: fixture.userId,
          originalEntry,
          reversalEntry,
        },
        event_log_sequence: expect.any(Number),
      },
    ])
    expect(first.publications).toEqual(
      publications.rows.map((publication) => ({
        publication_id: publication.publication_id,
        event_key: publication.publication_key,
        event_type: publication.event_type,
      })),
    )
    const state = await getPool().query<{
      active_count: string
      history_count: string
      history_payment_id: string
      allocation_owner_user_id: string
      allocation_created_at_preserved: boolean
      root_id: string
      invoice_status: string
      paid_amount: string
      remaining_amount: string
      transaction_pointer: string | null
      root_status: string
      reversed_by_id: string
      storno_status: string
      storno_commit_method: string
      storno_actor_type: string
      storno_actor_label: string | null
    }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_invoice_payments p
          WHERE p.journal_entry_id = $1) AS active_count,
         (SELECT count(*) FROM public.supplier_invoice_payment_history h
          WHERE h.lineage_root_journal_entry_id = $1) AS history_count,
         h.original_payment_id::text AS history_payment_id,
         h.allocation_owner_user_id::text,
         h.lineage_root_journal_entry_id::text AS root_id,
         i.status AS invoice_status,
         i.paid_amount::text,
         i.remaining_amount::text,
         t.journal_entry_id::text AS transaction_pointer,
         root.status AS root_status,
         root.reversed_by_id::text,
         storno.status AS storno_status,
         storno.commit_method AS storno_commit_method,
         storno.committed_actor_type AS storno_actor_type,
         storno.committed_actor_label AS storno_actor_label,
         h.allocation_created_at = $3::timestamptz
           AS allocation_created_at_preserved
       FROM public.supplier_invoice_payment_history h
       JOIN public.supplier_invoices i ON i.id = h.supplier_invoice_id
       JOIN public.transactions t ON t.id = h.transaction_id
       JOIN public.journal_entries root ON root.id = h.lineage_root_journal_entry_id
       JOIN public.journal_entries storno ON storno.id = h.reversed_by_journal_entry_id
       WHERE h.original_payment_id = $2`,
      [fixture.rootEntryId, fixture.paymentId, ALLOCATION_CREATED_AT],
    )
    expect(state.rows[0]).toMatchObject({
      active_count: '0',
      history_count: '1',
      history_payment_id: fixture.paymentId,
      allocation_owner_user_id: fixture.userId,
      allocation_created_at_preserved: true,
      root_id: fixture.rootEntryId,
      invoice_status: 'registered',
      transaction_pointer: null,
      root_status: 'reversed',
      storno_commit_method: 'user_accept',
      storno_actor_type: 'user',
      storno_actor_label: null,
      reversed_by_id: reversalId,
      storno_status: 'posted',
    })
    expect(Number(state.rows[0]!.paid_amount)).toBe(0)
    expect(Number(state.rows[0]!.remaining_amount)).toBe(100)

    const retry = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
    )
    expect(retry).toMatchObject({
      status: 'already_applied',
      root_journal_entry_id: fixture.rootEntryId,
      original_journal_entry_id: fixture.rootEntryId,
      reversal_journal_entry_id: reversalId,
      actor_type: 'user',
      actor_id: fixture.userId,
    })
    expect(retry.publications).toEqual(first.publications)

    const counts = await getPool().query<{ commands: string; stornos: string; publications: string }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals r
          WHERE r.root_journal_entry_id = $1) AS commands,
         (SELECT count(*) FROM public.journal_entries e
          WHERE e.reverses_id = $1 AND e.source_type = 'storno') AS stornos,
         (SELECT count(*) FROM public.accounting_publications p
          WHERE p.publication_key IN ($2, $3)) AS publications`,
      [
        fixture.rootEntryId,
        `journal:${reversalId}:committed`,
        `journal:${fixture.rootEntryId}:reversed`,
      ],
    )
    expect(counts.rows[0]).toEqual({ commands: '1', stornos: '1', publications: '2' })
  })

  it('selects the reversal period from its date and reports a changed-date retry conflict', async () => {
    const fixture = await seedPaidSupplierPayment()
    await getPool().query(
      `UPDATE public.fiscal_periods
       SET period_end = DATE '2026-05-31'
       WHERE id = $1`,
      [fixture.fiscalPeriodId],
    )
    const reversalPeriodId = await insertFiscalPeriod({
      userId: fixture.userId,
      companyId: fixture.companyId,
      periodStart: '2026-06-01',
      periodEnd: '2026-12-31',
      name: '2026 second period',
    })

    const first = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
      '2026-06-15',
    )
    const reversalId = first.reversal_journal_entry_id as string
    const selected = await getPool().query<{
      entry_date: string
      fiscal_period_id: string
      reversal_date: string
    }>(
      `SELECT reversal.entry_date::text,
              reversal.fiscal_period_id::text,
              command.reversal_date::text
       FROM public.supplier_payment_reversals command
       JOIN public.journal_entries reversal
         ON reversal.id = command.reversal_journal_entry_id
       WHERE command.root_journal_entry_id = $1`,
      [fixture.rootEntryId],
    )
    expect(selected.rows[0]).toEqual({
      entry_date: '2026-06-15',
      fiscal_period_id: reversalPeriodId,
      reversal_date: '2026-06-15',
    })

    const retry = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
      '2026-06-15',
    )
    expect(retry).toMatchObject({
      status: 'already_applied',
      reversal_journal_entry_id: reversalId,
    })
    expect(retry.publications).toEqual(first.publications)

    const conflict = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
      '2026-06-16',
    )
    expect(conflict).toEqual({
      status: 'conflict',
      reason: 'stored supplier reversal identity differs',
      company_id: fixture.companyId,
      root_journal_entry_id: fixture.rootEntryId,
      original_journal_entry_id: fixture.rootEntryId,
      reversal_journal_entry_id: reversalId,
    })
  })

  it('rejects reversals behind the company lock date and in a closed period', async () => {
    const locked = await seedPaidSupplierPayment()
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, DATE '2026-05-16')
       ON CONFLICT (company_id) DO UPDATE
       SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [locked.userId, locked.companyId],
    )
    await expect(
      reverse(
        locked.userId,
        locked.companyId,
        locked.rootEntryId,
        locked.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const closed = await seedPaidSupplierPayment()
    await getPool().query(
      `UPDATE public.fiscal_periods
       SET is_closed = true, closed_at = now()
       WHERE id = $1`,
      [closed.fiscalPeriodId],
    )
    await expect(
      reverse(
        closed.userId,
        closed.companyId,
        closed.rootEntryId,
        closed.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const unchanged = await getPool().query<{ commands: string; active: string }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals command
          WHERE command.root_journal_entry_id = ANY($1::uuid[])) AS commands,
         (SELECT count(*) FROM public.supplier_invoice_payments payment
          WHERE payment.id = ANY($2::uuid[])) AS active`,
      [
        [locked.rootEntryId, closed.rootEntryId],
        [locked.paymentId, closed.paymentId],
      ],
    )
    expect(unchanged.rows[0]).toEqual({ commands: '0', active: '2' })
  })

  it('accepts a labelled nullable service actor and rejects an unlabelled one', async () => {
    const missingLabel = await seedPaidSupplierPayment()
    await expect(
      reverseAsService(
        missingLabel.companyId,
        missingLabel.rootEntryId,
        missingLabel.rootEntryId,
        null,
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      reverseAsService(
        missingLabel.companyId,
        missingLabel.rootEntryId,
        missingLabel.rootEntryId,
        '   ',
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const rejectedState = await getPool().query<{ commands: string; active: string }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals
          WHERE root_journal_entry_id = $1) AS commands,
         (SELECT count(*) FROM public.supplier_invoice_payments
          WHERE id = $2) AS active`,
      [missingLabel.rootEntryId, missingLabel.paymentId],
    )
    expect(rejectedState.rows[0]).toEqual({ commands: '0', active: '1' })

    const fixture = await seedPaidSupplierPayment()
    const result = await reverseAsService(
      fixture.companyId,
      fixture.rootEntryId,
      fixture.rootEntryId,
      'verified supplier reversal worker',
    )
    expect(result).toMatchObject({
      status: 'applied',
      actor_type: 'cron',
      actor_id: null,
      actor_label: 'verified supplier reversal worker',
    })
    const command = await getPool().query<{
      actor_type: string
      actor_id: string | null
      actor_label: string
    }>(
      `SELECT actor_type, actor_id::text, actor_label
       FROM public.supplier_payment_reversals
       WHERE root_journal_entry_id = $1`,
      [fixture.rootEntryId],
    )
    expect(command.rows[0]).toEqual({
      actor_type: 'cron',
      actor_id: null,
      actor_label: 'verified supplier reversal worker',
    })

    const agentFixture = await seedPaidSupplierPayment()
    const agentLabel = 'verified supplier reversal agent'
    const agentResult = await reverseAsService(
      agentFixture.companyId,
      agentFixture.rootEntryId,
      agentFixture.rootEntryId,
      agentLabel,
      'agent_chat',
    )
    const agentProvenance = await getPool().query<{
      commit_method: string
      committed_actor_type: string
      committed_actor_label: string
    }>(
      `SELECT commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries
       WHERE id = $1`,
      [agentResult.reversal_journal_entry_id],
    )
    expect(agentProvenance.rows[0]).toEqual({
      commit_method: 'agent',
      committed_actor_type: 'agent_chat',
      committed_actor_label: agentLabel,
    })
  })

  it('separates the lineage root from the exact allocation owner', async () => {
    const fixture = await seedPaidSupplierPayment()
    const correctionId = await addAccountingEquivalentCorrection(fixture)

    const result = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      correctionId,
    )
    expect(result).toMatchObject({
      status: 'applied',
      root_journal_entry_id: fixture.rootEntryId,
      original_journal_entry_id: correctionId,
    })

    const identities = await getPool().query<{
      history_root_id: string
      history_owner_id: string
      command_owner_id: string
      reversal_parent_id: string
    }>(
      `SELECT
         history.lineage_root_journal_entry_id::text AS history_root_id,
         history.journal_entry_id::text AS history_owner_id,
         command.allocation_owner_journal_entry_id::text AS command_owner_id,
         reversal.reverses_id::text AS reversal_parent_id
       FROM public.supplier_invoice_payment_history history
       JOIN public.supplier_payment_reversals command
         ON command.id = history.reversal_command_id
       JOIN public.journal_entries reversal
         ON reversal.id = command.reversal_journal_entry_id
       WHERE history.original_payment_id = $1`,
      [fixture.paymentId],
    )
    expect(identities.rows[0]).toEqual({
      history_root_id: fixture.rootEntryId,
      history_owner_id: fixture.rootEntryId,
      command_owner_id: fixture.rootEntryId,
      reversal_parent_id: correctionId,
    })

    const retry = await reverse(
      fixture.userId,
      fixture.companyId,
      fixture.rootEntryId,
      correctionId,
    )
    expect(retry).toMatchObject({
      status: 'already_applied',
      root_journal_entry_id: fixture.rootEntryId,
      original_journal_entry_id: correctionId,
      reversal_journal_entry_id: result.reversal_journal_entry_id,
    })
  })

  it('rejects active allocations with forged source or owner provenance', async () => {
    const forgedSource = await seedPaidSupplierPayment()
    await forgeAllocationProvenance(forgedSource.paymentId, {
      sourceId: randomUUID(),
    })
    await expect(
      reverse(
        forgedSource.userId,
        forgedSource.companyId,
        forgedSource.rootEntryId,
        forgedSource.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const forgedOwner = await seedPaidSupplierPayment()
    const foreignOwnerUserId = await insertAuthUser()
    await forgeAllocationProvenance(forgedOwner.paymentId, {
      userId: foreignOwnerUserId,
    })
    await expect(
      reverse(
        forgedOwner.userId,
        forgedOwner.companyId,
        forgedOwner.rootEntryId,
        forgedOwner.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const unchanged = await getPool().query<{ commands: string; history: string }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals command
          WHERE command.root_journal_entry_id = ANY($1::uuid[])) AS commands,
         (SELECT count(*) FROM public.supplier_invoice_payment_history history
          WHERE history.original_payment_id = ANY($2::uuid[])) AS history`,
      [
        [forgedSource.rootEntryId, forgedOwner.rootEntryId],
        [forgedSource.paymentId, forgedOwner.paymentId],
      ],
    )
    expect(unchanged.rows[0]).toEqual({ commands: '0', history: '0' })
  })

  it('rejects direct and forged-cleanup deletion and preserves pointer-drift atomicity', async () => {
    const fixture = await seedPaidSupplierPayment()
    await expect(
      getPool().query(
        `DELETE FROM public.supplier_invoice_payments WHERE id = $1`,
        [fixture.paymentId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await withUserContext(fixture.userId, async (client) => {
      await client.query(
        `SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`,
      )
      await expect(
        client.query(
          `DELETE FROM public.supplier_invoice_payments WHERE id = $1`,
          [fixture.paymentId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = NULL WHERE id = $1`,
      [fixture.transactionId],
    )
    await expect(
      reverse(
        fixture.userId,
        fixture.companyId,
        fixture.rootEntryId,
        fixture.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const unchanged = await getPool().query<{
      status: string
      payment_count: string
      history_count: string
    }>(
      `SELECT e.status,
         (SELECT count(*) FROM public.supplier_invoice_payments p WHERE p.id = $2) AS payment_count,
         (SELECT count(*) FROM public.supplier_invoice_payment_history h
          WHERE h.original_payment_id = $2) AS history_count
       FROM public.journal_entries e WHERE e.id = $1`,
      [fixture.rootEntryId, fixture.paymentId],
    )
    expect(unchanged.rows[0]).toEqual({
      status: 'posted',
      payment_count: '1',
      history_count: '0',
    })
  })

  it('denies a different tenant and keeps posted-voucher deletion disabled', async () => {
    const fixture = await seedPaidSupplierPayment()
    const outsider = await seedCompany()
    await expect(
      reverse(
        outsider.userId,
        fixture.companyId,
        fixture.rootEntryId,
        fixture.rootEntryId,
      ),
    ).rejects.toMatchObject({ code: '42501' })

    await withUserContext(fixture.userId, async (client) => {
      await expect(
        client.query(`SELECT public.delete_last_voucher($1, $2)`, [
          fixture.companyId,
          fixture.rootEntryId,
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  it('fails closed for malformed, wrong, and cross-company roots', async () => {
    const fixture = await seedPaidSupplierPayment()
    const correctionId = await addAccountingEquivalentCorrection(fixture)
    const wrongRootId = await insertPostedJournalEntry({
      userId: fixture.userId,
      companyId: fixture.companyId,
      fiscalPeriodId: fixture.fiscalPeriodId,
      voucherNumber: arrivalSequence++,
      entryDate: '2026-05-15',
      description: 'Unrelated journal root',
      sourceType: 'manual',
      committedAt: '2026-05-15T10:00:00.000Z',
      lines: [
        { accountNumber: '1930', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '2999', debitAmount: 0, creditAmount: 100 },
      ],
    })
    const foreign = await seedPaidSupplierPayment()

    await expect(
      reverse(fixture.userId, fixture.companyId, correctionId, correctionId),
    ).rejects.toMatchObject({ code: 'P0002' })
    await expect(
      reverse(fixture.userId, fixture.companyId, wrongRootId, correctionId),
    ).rejects.toMatchObject({ code: '22023' })
    await expect(
      reverse(fixture.userId, fixture.companyId, foreign.rootEntryId, correctionId),
    ).rejects.toMatchObject({ code: 'P0002' })

    const unchanged = await getPool().query<{ commands: string; history: string }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals
          WHERE company_id = $1) AS commands,
         (SELECT count(*) FROM public.supplier_invoice_payment_history
          WHERE company_id = $1) AS history`,
      [fixture.companyId],
    )
    expect(unchanged.rows[0]).toEqual({ commands: '0', history: '0' })
  })

  it('locks every M2 graph row before supplier state mutation', async () => {
    const fixture = await seedPaidSupplierPayment()
    const correctionId = await addAccountingEquivalentCorrection(fixture)
    const blocker = await getClient()
    try {
      await blocker.query('BEGIN')
      await blocker.query(
        `SELECT id FROM public.journal_entries WHERE id = $1 FOR UPDATE`,
        [correctionId],
      )

      await expect(
        withUserContext(fixture.userId, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '100ms'`)
          await client.query(
            `SELECT public.apply_supplier_payment_reversal(
               $1, $2, $3, DATE '2026-05-16', 'user', $4, NULL
             )`,
            [fixture.companyId, fixture.rootEntryId, correctionId, fixture.userId],
          )
        }),
      ).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }

    const unchanged = await getPool().query<{
      commands: string
      active_allocations: string
      history: string
      correction_status: string
    }>(
      `SELECT
         (SELECT count(*) FROM public.supplier_payment_reversals
          WHERE company_id = $1) AS commands,
         (SELECT count(*) FROM public.supplier_invoice_payments
          WHERE id = $2) AS active_allocations,
         (SELECT count(*) FROM public.supplier_invoice_payment_history
          WHERE original_payment_id = $2) AS history,
         (SELECT status FROM public.journal_entries
          WHERE id = $3) AS correction_status`,
      [fixture.companyId, fixture.paymentId, correctionId],
    )
    expect(unchanged.rows[0]).toEqual({
      commands: '0',
      active_allocations: '1',
      history: '0',
      correction_status: 'posted',
    })
  })

  it('exposes only the mutation RPC and generic M2 lineage authority', async () => {
    const signatures = await getPool().query<{
      forbidden: string | null
      mutation: string | null
      legacy_mutation: string | null
      generic_lineage: string | null
    }>(
      `SELECT
         to_regprocedure(
           'public.get_supplier_payment_lineage(uuid,uuid[])'
         )::text AS forbidden,
         to_regprocedure(
           'public.apply_supplier_payment_reversal(uuid,uuid,uuid,date,text,uuid,text)'
         )::text AS mutation,
         to_regprocedure(
           'public.apply_supplier_payment_reversal(uuid,uuid,date,text,uuid,text)'
         )::text AS legacy_mutation,
         to_regprocedure(
           'public.get_journal_lineage(uuid,uuid[])'
         )::text AS generic_lineage`,
    )
    expect(signatures.rows[0]).toMatchObject({
      forbidden: null,
      legacy_mutation: null,
    })
    expect(signatures.rows[0]!.mutation).not.toBeNull()
    expect(signatures.rows[0]!.generic_lineage).not.toBeNull()

    const rows = await getPool().query<{
      name: string
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
      security_definer: boolean
      config: string[] | null
    }>(
      `SELECT p.proname AS name,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         p.prosecdef AS security_definer,
         p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'apply_supplier_payment_reversal',
           'get_journal_lineage',
           'resolve_supplier_reversal_actor',
           'supplier_reversal_lines_match',
           'supplier_accounting_lines_match',
           'guard_supplier_payment_allocation',
           'guard_supplier_payment_history_mutation',
           'guard_supplier_payment_parent_delete'
         )
       ORDER BY p.proname`,
    )
    const byName = Object.fromEntries(rows.rows.map((row) => [row.name, row]))
    expect(byName.apply_supplier_payment_reversal).toMatchObject({
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
      security_definer: true,
    })
    expect(byName.get_journal_lineage).toMatchObject({
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
      security_definer: false,
    })
    expect(
      rows.rows
        .filter((row) => row.authenticated_exec || row.service_exec)
        .map((row) => row.name),
    ).toEqual(['apply_supplier_payment_reversal', 'get_journal_lineage'])
    for (const privateName of [
      'guard_supplier_payment_allocation',
      'guard_supplier_payment_history_mutation',
      'guard_supplier_payment_parent_delete',
      'resolve_supplier_reversal_actor',
      'supplier_accounting_lines_match',
      'supplier_reversal_lines_match',
    ]) {
      expect(byName[privateName]).toMatchObject({
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      })
    }
    expect(byName.apply_supplier_payment_reversal.config).toContain(
      'search_path=pg_catalog, public',
    )
  })
})
