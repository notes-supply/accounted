import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'

let arrivalSequence = 0

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  total?: number
  initiallyPaid?: boolean
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Retention Supplier AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  const total = params.total ?? 1000
  const initiallyPaid = params.initiallyPaid ?? true
  const status = initiallyPaid ? 'paid' : 'registered'
  const paidAmount = initiallyPaid ? total : 0
  const remainingAmount = initiallyPaid ? 0 : total
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSequence++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, subtotal, vat_amount,
        total, paid_amount, remaining_amount, vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-05-01', '2026-05-31', '2026-05-01',
             $8, 'SEK', $7, 0, $7, $9, $10, 'standard_25', false, false)`,
    [
      invoiceId,
      params.userId,
      params.companyId,
      supplierId,
      arrivalNumber,
      `LF-${arrivalNumber}`,
      total,
      status,
      paidAmount,
      remainingAmount,
    ],
  )
  return invoiceId
}

async function insertPostedStorno(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalJournalEntryId: string
  amount?: number
}): Promise<string> {
  const stornoId = randomUUID()
  const amount = params.amount ?? 1000
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, reverses_id, status, committed_at)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-02', 'Payment storno',
               'storno', $5, 'posted', '2026-06-02T10:00:00Z')`,
      [
        stornoId,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.originalJournalEntryId,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', $2, 0, 'SEK', 0),
              ($1, '2440', 0, $2, 'SEK', 1)`,
      [stornoId, amount],
    )
    await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  await getPool().query(
    `UPDATE public.journal_entries
        SET status = 'reversed', reversed_by_id = $1
      WHERE id = $2`,
    [stornoId, params.originalJournalEntryId],
  )
  return stornoId
}

async function insertPayment(params: {
  userId: string
  companyId: string
  supplierInvoiceId: string
  journalEntryId: string
  transactionId?: string | null
  amount?: number
  paymentDate?: string
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO public.supplier_invoice_payments
       (user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
        journal_entry_id, transaction_id)
     VALUES ($1, $2, $3, $4, $5, 'SEK', $6, $7)
     RETURNING id`,
    [
      params.userId,
      params.companyId,
      params.supplierInvoiceId,
      params.paymentDate ?? '2026-06-01',
      params.amount ?? 1000,
      params.journalEntryId,
      params.transactionId ?? null,
    ],
  )
  return result.rows[0].id
}

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}
async function insertWebhook(companyId: string, eventType: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks
       (id, company_id, name, event_type, webhook_url, secret, active)
     VALUES ($1, $2, 'supplier-reversal-test', $3,
             'https://example.com/supplier-reversal', $4, true)`,
    [id, companyId, eventType, `whsec_${randomUUID().replaceAll('-', '')}`],
  )
  return id
}


type QueryClient = Pick<PoolClient, 'query'>

async function applySupplierPaymentReversal(
  client: QueryClient,
  params: {
    companyId: string
    originalJournalEntryId: string
    stornoJournalEntryId: string
  },
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT public.apply_supplier_payment_reversal($1, $2, $3) AS result`,
    [
      params.companyId,
      params.originalJournalEntryId,
      params.stornoJournalEntryId,
    ],
  )
  return result.rows[0].result as Record<string, unknown>
}

async function seedPaymentVoucher(total = 1000) {
  const tenant = await seedCompany()
  const supplierInvoiceId = await insertSupplierInvoice({
    userId: tenant.userId,
    companyId: tenant.companyId,
    total,
  })
  const journalEntryId = await insertPostedJournalEntry({
    ...tenant,
    sourceType: 'supplier_invoice_paid',
    sourceId: supplierInvoiceId,
    entryDate: '2026-06-01',
    committedAt: '2026-06-01T10:00:00Z',
    lines: [
      { accountNumber: '2440', debitAmount: total, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: total },
    ],
  })
  return { ...tenant, supplierInvoiceId, journalEntryId }
}

describe('supplier payment reversal retention migration', () => {
  it('keeps an existing-shaped row active after upgrade', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)

    const result = await getPool().query(
      `SELECT reversed_at, reversed_by_journal_entry_id
         FROM public.supplier_invoice_payments WHERE id = $1`,
      [paymentId],
    )
    expect(result.rows).toEqual([{ reversed_at: null, reversed_by_journal_entry_id: null }])
    const audit = await getPool().query<{ user_id: string; actor_id: string | null }>(
      `SELECT user_id, actor_id
         FROM public.audit_log
        WHERE table_name = 'supplier_invoice_payments'
          AND record_id = $1
          AND action = 'INSERT'`,
      [paymentId],
    )
    expect(audit.rows).toEqual([{ user_id: seeded.userId, actor_id: null }])
  })

  it('soft reversal preserves exact allocation fields and records the storno', async () => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction(seeded)
    const paymentId = await insertPayment({ ...seeded, transactionId, amount: 987.65 })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    await withUserContext(seeded.userId, async (client) => {
      await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
    }, { commit: true })

    const result = await getPool().query(
      `SELECT supplier_invoice_id, payment_date::text, amount::text, journal_entry_id,
              transaction_id, reversed_at, reversed_by_journal_entry_id
         FROM public.supplier_invoice_payments WHERE id = $1`,
      [paymentId],
    )
    expect(result.rows[0]).toMatchObject({
      supplier_invoice_id: seeded.supplierInvoiceId,
      payment_date: '2026-06-01',
      amount: '987.65',
      journal_entry_id: seeded.journalEntryId,
      transaction_id: transactionId,
      reversed_by_journal_entry_id: stornoId,
    })
    expect(result.rows[0].reversed_at).toBeTruthy()
  })

  it('makes exact allocation fields immutable once reversal starts', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    await expect(
      getPool().query(
        `UPDATE public.supplier_invoice_payments
            SET amount = amount + 1,
                reversed_at = now(),
                reversed_by_journal_entry_id = $1
          WHERE id = $2`,
        [stornoId, paymentId],
      ),
    ).rejects.toThrow(/allocation fields are immutable/i)

    await withUserContext(seeded.userId, async (client) => {
      await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
    }, { commit: true })
    await expect(
      getPool().query(
        `UPDATE public.supplier_invoice_payments SET amount = amount + 1 WHERE id = $1`,
        [paymentId],
      ),
    ).rejects.toThrow(/allocation fields are immutable/i)
  })

  it('makes exact allocation fields immutable before reversal', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)

    await expect(
      getPool().query(
        `UPDATE public.supplier_invoice_payments
            SET amount = amount + 1,
                notes = 'retargeted before reversal'
          WHERE id = $1`,
        [paymentId],
      ),
    ).rejects.toThrow(/allocation fields are immutable/i)
  })

  it('allows rematch after reversal but rejects a duplicate active transaction allocation', async () => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction(seeded)
    await insertPayment({ ...seeded, transactionId })

    await expect(insertPayment({ ...seeded, transactionId })).rejects.toThrow(/unique/i)

    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })
    await withUserContext(seeded.userId, async (client) => {
      await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
    }, { commit: true })

    const rematchJournalEntryId = await insertPostedJournalEntry({
      ...seeded,
      sourceType: 'supplier_invoice_paid',
      sourceId: seeded.supplierInvoiceId,
      entryDate: '2026-06-03',
      committedAt: '2026-06-03T10:00:00Z',
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await expect(insertPayment({
      ...seeded,
      journalEntryId: rematchJournalEntryId,
      transactionId,
    })).resolves.toBeTruthy()
  })

  it('rejects new duplicate active journal allocations without rewriting historical rows', async () => {
    const seeded = await seedPaymentVoucher()
    await insertPayment(seeded)

    await expect(insertPayment(seeded)).rejects.toThrow(
      /duplicate active supplier payment journal allocation/i,
    )
  })

  it('blocks hard DELETE even for a privileged direct writer', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)

    await expect(
      getPool().query(`DELETE FROM public.supplier_invoice_payments WHERE id = $1`, [paymentId]),
    ).rejects.toThrow(/retained and cannot be deleted/i)
  })

  it('keeps tenant RLS isolation unchanged for retained rows', async () => {
    const a = await seedPaymentVoucher()
    const b = await seedPaymentVoucher()
    const paymentA = await insertPayment(a)
    const paymentB = await insertPayment(b)
    await setActiveCompany(a.userId, a.companyId)

    await withUserContext(a.userId, async (client) => {
      const visible = await client.query<{ id: string }>(
        `SELECT id FROM public.supplier_invoice_payments WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[paymentA, paymentB]],
      )
      expect(visible.rows.map((row) => row.id)).toEqual([paymentA])

      const update = await client.query(
        `UPDATE public.supplier_invoice_payments SET notes = 'cross-tenant' WHERE id = $1`,
        [paymentB],
      )
      expect(update.rowCount).toBe(0)
    })
  })

  it('accepts own-company pointers and rejects foreign journal or transaction pointers', async () => {
    const own = await seedPaymentVoucher()
    const foreign = await seedPaymentVoucher()
    const ownTransactionId = await insertTransaction(own)
    const foreignTransactionId = await insertTransaction(foreign)
    const insertSql = `
      INSERT INTO public.supplier_invoice_payments (
        user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
        journal_entry_id, transaction_id
      ) VALUES ($1, $2, $3, '2026-06-01', 1000, 'SEK', $4, $5)
      RETURNING id
    `

    await expect(withUserContext(own.userId, (client) =>
      client.query(insertSql, [
        own.userId,
        own.companyId,
        own.supplierInvoiceId,
        foreign.journalEntryId,
        ownTransactionId,
      ]),
    )).rejects.toThrow(/journal target mismatch/i)

    await expect(withUserContext(own.userId, (client) =>
      client.query(insertSql, [
        own.userId,
        own.companyId,
        own.supplierInvoiceId,
        own.journalEntryId,
        foreignTransactionId,
      ]),
    )).rejects.toThrow(/transaction company mismatch/i)

    const poisoned = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.supplier_invoice_payments
        WHERE supplier_invoice_id = $1
          AND (
            journal_entry_id = $2
            OR transaction_id = $3
          )`,
      [own.supplierInvoiceId, foreign.journalEntryId, foreignTransactionId],
    )
    expect(poisoned.rows).toEqual([{ count: '0' }])

    const ownInsert = await withUserContext(own.userId, (client) =>
      client.query<{ id: string }>(insertSql, [
        own.userId,
        own.companyId,
        own.supplierInvoiceId,
        own.journalEntryId,
        ownTransactionId,
      ]), { commit: true })
    expect(ownInsert.rows).toHaveLength(1)
  })

  it('requires the atomic command for an authenticated allocation reversal', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })
    await setActiveCompany(seeded.userId, seeded.companyId)

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.supplier_invoice_payments
              SET reversed_at = now(), reversed_by_journal_entry_id = $1
            WHERE id = $2`,
          [stornoId, paymentId],
        ),
      ).rejects.toThrow(/must be reversed by the atomic command/i)
    })
  })

  it('retains every exact batch allocation under the shared voucher reversal', async () => {
    const seeded = await seedPaymentVoucher(1500)
    const secondInvoiceId = await insertSupplierInvoice({
      userId: seeded.userId,
      companyId: seeded.companyId,
      total: 500,
    })
    const transactionId = await insertTransaction({
      userId: seeded.userId,
      companyId: seeded.companyId,
      amount: -1500,
    })
    await insertPayment({ ...seeded, transactionId, amount: 1000 })
    await insertPayment({
      ...seeded,
      supplierInvoiceId: secondInvoiceId,
      transactionId,
      amount: 500,
    })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: 1500,
    })

    const result = await withUserContext(seeded.userId, async (client) =>
      applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      }), { commit: true })
    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      allocation_count: 2,
      invoice_count: 2,
    })

    const updated = await getPool().query(
      `SELECT supplier_invoice_id, amount::text, journal_entry_id,
              reversed_by_journal_entry_id
         FROM public.supplier_invoice_payments
        WHERE company_id = $1 AND journal_entry_id = $2
        ORDER BY supplier_invoice_id`,
      [seeded.companyId, seeded.journalEntryId],
    )

    expect(updated.rows).toHaveLength(2)
    expect(updated.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        supplier_invoice_id: seeded.supplierInvoiceId,
        amount: '1000',
        journal_entry_id: seeded.journalEntryId,
        reversed_by_journal_entry_id: stornoId,
      }),
      expect.objectContaining({
        supplier_invoice_id: secondInvoiceId,
        amount: '500',
        journal_entry_id: seeded.journalEntryId,
        reversed_by_journal_entry_id: stornoId,
      }),
    ]))
  })

  it('atomically restores one invoice, retains its allocation, and releases its transaction', async () => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -1000,
      journalEntryId: seeded.journalEntryId,
    })
    const paymentId = await insertPayment({ ...seeded, transactionId })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET payment_journal_entry_id = $1
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1, is_business = true, category = 'expense_other'
        WHERE id = $2`,
      [seeded.supplierInvoiceId, transactionId],
    )
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    const commandResult = await withUserContext(seeded.userId, async (client) =>
      applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      }), { commit: true })

    expect(commandResult).toMatchObject({
      ok: true,
      status: 'applied',
      allocation_count: 1,
      invoice_count: 1,
      transaction_count: 1,
    })

    const invoice = await getPool().query(
      `SELECT status, paid_amount::text, remaining_amount::text, paid_at,
              payment_journal_entry_id
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'overdue',
      paid_amount: '0',
      remaining_amount: '1000',
      paid_at: null,
      payment_journal_entry_id: null,
    }])

    const payment = await getPool().query(
      `SELECT reversed_at, reversed_by_journal_entry_id
         FROM public.supplier_invoice_payments
        WHERE id = $1`,
      [paymentId],
    )
    expect(payment.rows[0].reversed_at.toISOString()).toBe('2026-06-02T10:00:00.000Z')
    expect(payment.rows[0].reversed_by_journal_entry_id).toBe(stornoId)

    const transaction = await getPool().query(
      `SELECT journal_entry_id, supplier_invoice_id, is_business, category
         FROM public.transactions
        WHERE id = $1`,
      [transactionId],
    )
    expect(transaction.rows).toEqual([{
      journal_entry_id: null,
      supplier_invoice_id: null,
      is_business: null,
      category: null,
    }])
  })

  it('reverses a sanctioned allocation-backed manual voucher exactly once', async () => {
    const tenant = await seedCompany()
    const supplierInvoiceId = await insertSupplierInvoice({
      userId: tenant.userId,
      companyId: tenant.companyId,
      initiallyPaid: false,
    })
    const manualJournalEntryId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'manual',
      entryDate: '2026-06-01',
      committedAt: '2026-06-01T10:00:00Z',
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })

    const linked = await withUserContext(tenant.userId, (client) =>
      client.query<{ result: { ok: boolean; payment_id: string } }>(
        `SELECT public.link_supplier_invoice_to_voucher($1, $2, $3, $4, NULL) AS result`,
        [supplierInvoiceId, manualJournalEntryId, tenant.userId, tenant.companyId],
      ), { commit: true })
    expect(linked.rows[0]?.result.ok).toBe(true)
    const paymentId = linked.rows[0]!.result.payment_id

    const transactionId = await insertTransaction({
      ...tenant,
      amount: -1000,
      journalEntryId: manualJournalEntryId,
    })
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1, is_business = true, category = 'expense_other'
        WHERE id = $2`,
      [supplierInvoiceId, transactionId],
    )
    const stornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: manualJournalEntryId,
    })

    await withUserContext(tenant.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: manualJournalEntryId,
        stornoJournalEntryId: stornoId,
      })
      const second = await applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: manualJournalEntryId,
        stornoJournalEntryId: stornoId,
      })
      expect(first).toMatchObject({ ok: true, status: 'applied' })
      expect(second).toMatchObject({ ok: true, status: 'already_applied' })
    }, { commit: true })

    const state = await getPool().query(
      `SELECT si.status, si.paid_amount::text, si.remaining_amount::text,
              sip.reversed_at, sip.reversed_by_journal_entry_id,
              t.journal_entry_id, t.supplier_invoice_id, t.is_business, t.category
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1 AND sip.id = $2`,
      [supplierInvoiceId, paymentId, transactionId],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'overdue',
      paid_amount: '0',
      remaining_amount: '1000',
      reversed_by_journal_entry_id: stornoId,
      journal_entry_id: null,
      supplier_invoice_id: null,
      is_business: null,
      category: null,
    })
    expect(state.rows[0].reversed_at).toBeTruthy()

    const reversals = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1
          AND reverses_id = $2
          AND source_type = 'storno'
          AND status = 'posted'`,
      [tenant.companyId, manualJournalEntryId],
    )
    expect(reversals.rows).toEqual([{ count: '1' }])
  })

  it('returns already_applied on an exact retry without subtracting twice', async () => {
    const seeded = await seedPaymentVoucher()
    await insertPayment(seeded)
    const committedWebhookId = await insertWebhook(
      seeded.companyId,
      'journal_entry.committed',
    )
    const reversedWebhookId = await insertWebhook(
      seeded.companyId,
      'journal_entry.reversed',
    )
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    await withUserContext(seeded.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      const second = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      expect(first).toMatchObject({
        ok: true,
        status: 'applied',
        event_publication: {
          status: 'published',
          event_log_count: 2,
          webhook_delivery_count: 2,
        },
      })
      expect(second).toMatchObject({
        ok: true,
        status: 'already_applied',
        event_publication: {
          status: 'already_published',
          event_log_count: 2,
          webhook_delivery_count: 2,
        },
      })

      const publication = first.event_publication as {
        event_outbox_ids: string[]
      }
      const events = await client.query<{
        event_type: string
        entity_id: string
        data: Record<string, unknown>
      }>(
        `SELECT event_type, entity_id, data
           FROM public.event_log
          WHERE outbox_event_id = ANY($1::uuid[])
          ORDER BY event_type`,
        [publication.event_outbox_ids],
      )
      expect(events.rows).toHaveLength(2)
      expect(events.rows[0]).toMatchObject({
        event_type: 'journal_entry.committed',
        entity_id: stornoId,
        data: { entry: { id: stornoId } },
      })
      expect(events.rows[1]).toMatchObject({
        event_type: 'journal_entry.reversed',
        entity_id: stornoId,
        data: {
          originalEntry: { id: seeded.journalEntryId },
          reversalEntry: { id: stornoId },
        },
      })

      const deliveries = await client.query<{ webhook_id: string }>(
        `SELECT webhook_id
           FROM public.webhook_deliveries
          WHERE outbox_event_id = ANY($1::uuid[])
          ORDER BY event_type`,
        [publication.event_outbox_ids],
      )
      expect(deliveries.rows.map((row) => row.webhook_id)).toEqual([
        committedWebhookId,
        reversedWebhookId,
      ])

      const invoice = await client.query(
        `SELECT paid_amount::text, remaining_amount::text
           FROM public.supplier_invoices
          WHERE id = $1`,
        [seeded.supplierInvoiceId],
      )
      expect(invoice.rows).toEqual([{ paid_amount: '0', remaining_amount: '1000' }])
    })
  })

  it('rejects a mismatched storno and leaves supplier state unchanged', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)
    const otherJournalEntryId = await insertPostedJournalEntry({
      ...seeded,
      sourceType: 'supplier_invoice_paid',
      sourceId: seeded.supplierInvoiceId,
      entryDate: '2026-06-01',
      committedAt: '2026-06-01T11:00:00Z',
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const wrongStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: otherJournalEntryId,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: wrongStornoId,
        }),
      ).rejects.toThrow(/original journal entry mismatch|exact posted storno/i)
    })

    const state = await getPool().query(
      `SELECT si.status, si.paid_amount::text, sip.reversed_at,
              sip.reversed_by_journal_entry_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
        WHERE si.id = $1 AND sip.id = $2`,
      [seeded.supplierInvoiceId, paymentId],
    )
    expect(state.rows).toEqual([{
      status: 'paid',
      paid_amount: '1000',
      reversed_at: null,
      reversed_by_journal_entry_id: null,
    }])
  })

  it('rolls back every write when one batch invoice has conflicting state', async () => {
    const seeded = await seedPaymentVoucher(1500)
    const secondInvoiceId = await insertSupplierInvoice({
      userId: seeded.userId,
      companyId: seeded.companyId,
      total: 500,
    })
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -1500,
      journalEntryId: seeded.journalEntryId,
    })
    await insertPayment({ ...seeded, transactionId, amount: 1000 })
    await insertPayment({
      ...seeded,
      supplierInvoiceId: secondInvoiceId,
      transactionId,
      amount: 500,
    })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET status = 'partially_paid', paid_amount = 100, remaining_amount = 400
        WHERE id = $1`,
      [secondInvoiceId],
    )
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: 1500,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: stornoId,
        }),
      ).rejects.toThrow(/invoice state conflict/i)
    })

    const invoices = await getPool().query(
      `SELECT id, status, paid_amount::text, remaining_amount::text
         FROM public.supplier_invoices
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[seeded.supplierInvoiceId, secondInvoiceId]],
    )
    expect(invoices.rows).toEqual(expect.arrayContaining([
      {
        id: seeded.supplierInvoiceId,
        status: 'paid',
        paid_amount: '1500',
        remaining_amount: '0',
      },
      {
        id: secondInvoiceId,
        status: 'partially_paid',
        paid_amount: '100',
        remaining_amount: '400',
      },
    ]))

    const allocations = await getPool().query(
      `SELECT reversed_at, reversed_by_journal_entry_id
         FROM public.supplier_invoice_payments
        WHERE journal_entry_id = $1`,
      [seeded.journalEntryId],
    )
    expect(allocations.rows).toHaveLength(2)
    expect(allocations.rows).toEqual([
      { reversed_at: null, reversed_by_journal_entry_id: null },
      { reversed_at: null, reversed_by_journal_entry_id: null },
    ])

    const transaction = await getPool().query(
      `SELECT journal_entry_id FROM public.transactions WHERE id = $1`,
      [transactionId],
    )
    expect(transaction.rows).toEqual([{ journal_entry_id: seeded.journalEntryId }])
  })

  it('rejects an ordinary supplier payment with no retained allocation evidence', async () => {
    const seeded = await seedPaymentVoucher()
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: stornoId,
        }),
      ).rejects.toThrow(/no retained allocations/i)
    }, { commit: true })

    const invoice = await getPool().query(
      `SELECT status, paid_amount::text, remaining_amount::text
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'paid',
      paid_amount: '1000.00',
      remaining_amount: '0.00',
    }])
  })

  it('atomically supports a source-linked legacy full cash payment without allocations', async () => {
    const tenant = await seedCompany()
    const supplierInvoiceId = await insertSupplierInvoice({
      userId: tenant.userId,
      companyId: tenant.companyId,
      total: 750,
    })
    const journalEntryId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'supplier_invoice_cash_payment',
      sourceId: supplierInvoiceId,
      entryDate: '2026-06-01',
      committedAt: '2026-06-01T10:00:00Z',
      lines: [
        { accountNumber: '2440', debitAmount: 750, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 750 },
      ],
    })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET payment_journal_entry_id = $1
        WHERE id = $2`,
      [journalEntryId, supplierInvoiceId],
    )
    const stornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: journalEntryId,
      amount: 750,
    })

    await withUserContext(tenant.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      const second = await applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      expect(first).toMatchObject({ ok: true, status: 'applied_legacy' })
      expect(second).toMatchObject({ ok: true, status: 'already_applied_legacy' })
    })
  })

  it('records the authenticated reversing member without changing allocation ownership', async () => {
    const seeded = await seedPaymentVoucher()
    const adminId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seeded.companyId,
      userId: adminId,
      role: 'admin',
    })
    const inserted = await withUserContext(seeded.userId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO public.supplier_invoice_payments (
           user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
           journal_entry_id
         ) VALUES ($1, $2, $3, '2026-06-01', 1000, 'SEK', $4)
         RETURNING id`,
        [
          seeded.userId,
          seeded.companyId,
          seeded.supplierInvoiceId,
          seeded.journalEntryId,
        ],
      ), { commit: true })
    const paymentId = inserted.rows[0]!.id
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    await withUserContext(adminId, (client) =>
      applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      }), { commit: true })

    const audit = await getPool().query<{
      user_id: string
      actor_id: string | null
      action: string
    }>(
      `SELECT user_id, actor_id, action
         FROM public.audit_log
        WHERE table_name = 'supplier_invoice_payments'
          AND record_id = $1
        ORDER BY created_at, id`,
      [paymentId],
    )
    expect(audit.rows).toEqual([
      { user_id: seeded.userId, actor_id: seeded.userId, action: 'INSERT' },
      { user_id: seeded.userId, actor_id: adminId, action: 'UPDATE' },
    ])
  })

  it('allows sanctioned sandbox cleanup to remove an active retained allocation', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox)
       VALUES ($1, $2, true)`,
      [seeded.userId, seeded.companyId],
    )

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [seeded.userId])

    const remaining = await getPool().query<{ payment_count: string; user_count: string }>(
      `SELECT
         (SELECT count(*)::text
            FROM public.supplier_invoice_payments
           WHERE id = $1) AS payment_count,
         (SELECT count(*)::text
            FROM auth.users
           WHERE id = $2) AS user_count`,
      [paymentId, seeded.userId],
    )
    expect(remaining.rows).toEqual([{ payment_count: '0', user_count: '0' }])
  })

  it('pins the exact atomic RPC signature, security mode, and grants', async () => {
    const signature =
      'public.apply_supplier_payment_reversal(uuid,uuid,uuid)'
    const meta = await getPool().query(
      `SELECT p.prosecdef,
              p.proconfig,
              has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated_exec,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service_exec,
              EXISTS (
                SELECT 1
                  FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                 WHERE acl.grantee = 0
                   AND acl.privilege_type = 'EXECUTE'
              ) AS public_exec
         FROM pg_proc p
        WHERE p.oid = $1::regprocedure`,
      [signature],
    )
    expect(meta.rows).toEqual([{
      prosecdef: true,
      proconfig: ['search_path=public'],
      anon_exec: false,
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
    }])
  })
})
