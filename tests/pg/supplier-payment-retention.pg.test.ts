import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withErrorSavepoint, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'

let arrivalSequence = 0

const SHIPPED_MIGRATION =
  '20260813120000_supplier_payment_reversal_retention.sql'
const HARDENING_MIGRATION =
  '20260813130000_harden_journal_delete_and_supplier_lineage.sql'
const SHIPPED_MIGRATION_BLOB = '18a353108a36012e92a0efaf97f2d6c27f287241'
const MAX_LINEAGE_DEPTH = 32
const MAX_LINEAGE_ROWS = 20000

function migration(name: string): string {
  return readFileSync(
    resolve(process.cwd(), 'supabase/migrations', name),
    'utf8',
  )
}

function gitBlobHash(contents: string): string {
  const body = Buffer.from(contents)
  return createHash('sha1')
    .update(`blob ${body.byteLength}\0`)
    .update(body)
    .digest('hex')
}

function sqlFunction(
  contents: string,
  signature: string,
  endMarker: string,
): string {
  const start = contents.indexOf(signature)
  const end = contents.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`Cannot extract migration function: ${signature}`)
  }
  return contents.slice(start, end)
}

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
  entryDate?: string
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
       VALUES ($1, $2, $3, $4, 0, 'A', $6, 'Payment storno',
               'storno', $5, 'posted', ($6::date + time '10:00')::timestamptz)`,
      [
        stornoId,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.originalJournalEntryId,
        params.entryDate ?? '2026-06-02',
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

async function insertPostedCorrection(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalJournalEntryId: string
  entryDate: string
  amount?: number
}): Promise<string> {
  const correctionId = randomUUID()
  const amount = params.amount ?? 1000
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status, committed_at)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Payment correction',
               'correction', $6, 'posted', ($5::date + time '10:00')::timestamptz)`,
      [
        correctionId,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.entryDate,
        params.originalJournalEntryId,
      ],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '2440', $2, 0, 'SEK', 0),
              ($1, '1930', 0, $2, 'SEK', 1)`,
      [correctionId, amount],
    )
    await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return correctionId
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

function getEventOutboxIds(result: Record<string, unknown>): string[] {
  const publication = result.event_publication
  if (
    publication === null
    || typeof publication !== 'object'
    || !('event_outbox_ids' in publication)
    || !Array.isArray(publication.event_outbox_ids)
    || publication.event_outbox_ids.some((id) => typeof id !== 'string')
  ) {
    throw new Error('supplier reversal result omitted event outbox IDs')
  }
  return publication.event_outbox_ids
}

async function getSupplierPaymentLineage(
  client: QueryClient,
  companyId: string,
  rootIds: string[],
): Promise<{
  requested_root_count: number
  rows: Array<Record<string, unknown>>
}> {
  const result = await client.query(
    `SELECT public.get_supplier_payment_lineage($1, $2::uuid[]) AS result`,
    [companyId, rootIds],
  )
  return result.rows[0].result
}

async function deleteLastVoucher(
  client: QueryClient,
  companyId: string,
  journalEntryId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT public.delete_last_voucher($1, $2) AS result`,
    [companyId, journalEntryId],
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
  return { ...tenant, supplierInvoiceId, journalEntryId, total }
}

async function seedV1PaymentWithoutAllocation(params: {
  total?: number
  priorPaidAmount?: number
  paymentAmount?: number
  lines?: Array<{
    accountNumber: string
    debitAmount: number
    creditAmount: number
  }>
  withTransaction?: boolean
}) {
  const tenant = await seedCompany()
  const total = params.total ?? 1000
  const priorPaidAmount = params.priorPaidAmount ?? 0
  const paymentAmount = params.paymentAmount ?? 400
  const paidAmount = Math.round((priorPaidAmount + paymentAmount) * 100) / 100
  const remainingAmount = Math.round((total - paidAmount) * 100) / 100
  const supplierInvoiceId = await insertSupplierInvoice({
    userId: tenant.userId,
    companyId: tenant.companyId,
    total,
    initiallyPaid: false,
  })
  const journalEntryId = await insertPostedJournalEntry({
    ...tenant,
    sourceType: 'supplier_invoice_paid',
    sourceId: supplierInvoiceId,
    entryDate: '2026-06-01',
    committedAt: '2026-06-01T10:00:00Z',
    lines: params.lines ?? [
      { accountNumber: '2440', debitAmount: paymentAmount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: paymentAmount },
    ],
  })
  await getPool().query(
    `UPDATE public.supplier_invoices
        SET status = $1,
            paid_amount = $2,
            remaining_amount = $3,
            paid_at = $4,
            payment_journal_entry_id = $5
      WHERE id = $6`,
    [
      remainingAmount === 0 ? 'paid' : 'partially_paid',
      paidAmount,
      remainingAmount,
      remainingAmount === 0 ? '2026-06-01T12:00:00Z' : null,
      journalEntryId,
      supplierInvoiceId,
    ],
  )

  let transactionId: string | null = null
  if (params.withTransaction) {
    transactionId = await insertTransaction({
      ...tenant,
      amount: -paymentAmount,
      journalEntryId,
    })
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1,
              is_business = true,
              category = 'expense_other'
        WHERE id = $2`,
      [supplierInvoiceId, transactionId],
    )
  }

  return {
    ...tenant,
    supplierInvoiceId,
    journalEntryId,
    transactionId,
    total,
    paidAmount,
    remainingAmount,
    paymentAmount,
  }
}


describe('supplier payment reversal retention migration', () => {
  it('applies the later migration over the exact shipped release shape', async () => {
    const shipped = migration(SHIPPED_MIGRATION)
    const hardening = migration(HARDENING_MIGRATION)
    const priorTriggerMigration = migration(
      '20260723210000_verifikat_inline_rattelse.sql',
    )
    const priorDocumentLinkMigration = migration(
      '20260705100000_fix_correction_relink_role_detection.sql',
    )
    const priorDocumentMetadataMigration = migration(
      '20260704103000_allow_correction_document_relink.sql',
    )
    const priorRetentionMigration = migration(
      '20260415000000_schema_sync.sql',
    )
    const priorReplaceMigration = migration(
      '20260727120000_replace_sie_import_authorize_actor.sql',
    )
    const priorUndoMigration = migration(
      '20260727121000_undo_sie_import_caller_guard.sql',
    )

    expect(gitBlobHash(shipped)).toBe(SHIPPED_MIGRATION_BLOB)
    expect(shipped).not.toContain('get_supplier_payment_lineage')
    expect(shipped).toContain(
      'Cannot delete allocation-backed supplier payment voucher',
    )
    expect(hardening).toContain(
      'Only genuine draft journal entries can be physically deleted',
    )
    expect(hardening).toContain('get_supplier_payment_lineage')
    expect(hardening).toContain(
      'uq_journal_entries_committed_correction_child',
    )
    expect(hardening).toContain(
      'supplier payment reversal blocked by live correction child',
    )
    for (const controlledSignature of [
      'CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()',
      'CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()',
      'CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()',
    ]) {
      expect(hardening).not.toContain(controlledSignature)
    }

    const shippedDelete = sqlFunction(
      shipped,
      'CREATE OR REPLACE FUNCTION public.delete_last_voucher(',
      '\n\nNOTIFY pgrst',
    )
    const priorTrigger = sqlFunction(
      priorTriggerMigration,
      'CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()',
      '\n\nALTER FUNCTION public.enforce_journal_entry_immutability()',
    )
    const priorLineTrigger = sqlFunction(
      priorTriggerMigration,
      'CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()',
      '\n\nALTER FUNCTION public.enforce_journal_entry_line_immutability()',
    )
    const priorRetentionTrigger = sqlFunction(
      priorRetentionMigration,
      'CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()',
      '\n\n-- 4f.',
    )
    const priorDocumentLink = sqlFunction(
      priorDocumentLinkMigration,
      'CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()',
      '\n\n-- The trigger fired only',
    )
    const priorDocumentMetadata = sqlFunction(
      priorDocumentMetadataMigration,
      'CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()',
      '\n\n-- ── 3.',
    )
    const priorReplace = sqlFunction(
      priorReplaceMigration,
      'CREATE OR REPLACE FUNCTION public.replace_sie_import(',
      '\n\n-- Least privilege.',
    )
    const priorUndo = sqlFunction(
      priorUndoMigration,
      'CREATE OR REPLACE FUNCTION public.undo_sie_import(',
      '\n\n-- Least privilege,',
    )
    const shippedEventRecorder = sqlFunction(
      shipped,
      'CREATE OR REPLACE FUNCTION public.record_supplier_payment_reversal_events(',
      '\n\nREVOKE ALL ON FUNCTION public.record_supplier_payment_reversal_events(',
    )
    const shippedApply = sqlFunction(
      shipped,
      'CREATE OR REPLACE FUNCTION public.apply_supplier_payment_reversal(',
      '\n\nCOMMENT ON FUNCTION public.apply_supplier_payment_reversal',
    )

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(priorTrigger)
      await client.query(shippedDelete)
      await client.query(priorLineTrigger)
      await client.query(priorRetentionTrigger)
      await client.query(priorDocumentLink)
      await client.query(priorDocumentMetadata)
      await client.query(priorReplace)
      await client.query(priorUndo)
      await client.query(shippedEventRecorder)
      await client.query(shippedApply)
      await client.query(
        'DROP FUNCTION IF EXISTS public.get_supplier_payment_lineage(uuid, uuid[])',
      )
      const controlledBefore = await client.query<{
        trigger_definition: string
        line_trigger_definition: string
        retention_trigger_definition: string
      }>(
        `SELECT
           pg_get_functiondef(
             'public.enforce_journal_entry_immutability()'::regprocedure
           ) AS trigger_definition,
           pg_get_functiondef(
             'public.enforce_journal_entry_line_immutability()'::regprocedure
           ) AS line_trigger_definition,
           pg_get_functiondef(
             'public.enforce_retention_journal_entries()'::regprocedure
           ) AS retention_trigger_definition`,
      )
      await client.query(hardening)
      const definitions = await client.query<{
        delete_definition: string
        lineage_definition: string
        trigger_definition: string
        line_trigger_definition: string
        retention_trigger_definition: string
        document_link_definition: string
        document_metadata_definition: string
        undo_definition: string
        replace_definition: string
        event_definition: string
        apply_definition: string
        payment_retention_definition: string
      }>(
        `SELECT
           pg_get_functiondef(
             'public.delete_last_voucher(uuid,uuid)'::regprocedure
           ) AS delete_definition,
           pg_get_functiondef(
             'public.get_supplier_payment_lineage(uuid,uuid[])'::regprocedure
           ) AS lineage_definition,
           pg_get_functiondef(
             'public.enforce_journal_entry_immutability()'::regprocedure
           ) AS trigger_definition,
           pg_get_functiondef(
             'public.enforce_journal_entry_line_immutability()'::regprocedure
           ) AS line_trigger_definition,
           pg_get_functiondef(
             'public.enforce_retention_journal_entries()'::regprocedure
           ) AS retention_trigger_definition,
           pg_get_functiondef(
             'public.enforce_document_journal_entry_immutability()'::regprocedure
           ) AS document_link_definition,
           pg_get_functiondef(
             'public.enforce_document_metadata_immutability()'::regprocedure
           ) AS document_metadata_definition,
           pg_get_functiondef(
             'public.undo_sie_import(uuid,uuid,uuid)'::regprocedure
           ) AS undo_definition,
           pg_get_functiondef(
             'public.replace_sie_import(uuid,uuid,uuid)'::regprocedure
           ) AS replace_definition,
           pg_get_functiondef(
             'public.record_supplier_payment_reversal_events(uuid,uuid,uuid)'::regprocedure
           ) AS event_definition,
           pg_get_functiondef(
             'public.apply_supplier_payment_reversal(uuid,uuid,uuid)'::regprocedure
           ) AS apply_definition,
           pg_get_functiondef(
             'public.enforce_supplier_invoice_payment_retention()'::regprocedure
           ) AS payment_retention_definition`,
      )
      const installed = definitions.rows[0]!
      expect({
        trigger_definition: installed.trigger_definition,
        line_trigger_definition: installed.line_trigger_definition,
        retention_trigger_definition: installed.retention_trigger_definition,
      }).toEqual(controlledBefore.rows[0])
      expect(installed.delete_definition).toContain(
        'Only genuine draft journal entries can be physically deleted',
      )
      expect(installed.lineage_definition).toContain(
        `v_max_depth constant integer := ${MAX_LINEAGE_DEPTH}`,
      )
      expect(installed.lineage_definition).toContain(
        `v_max_rows constant integer := ${MAX_LINEAGE_ROWS}`,
      )
      expect(installed.lineage_definition).toContain(
        `entry.status IN ('posted', 'reversed')`,
      )
      expect(installed.lineage_definition).toContain(
        `child.status IN ('posted', 'reversed')`,
      )
      for (const guardDefinition of [
        installed.document_link_definition,
        installed.document_metadata_definition,
      ]) {
        expect(guardDefinition).toContain('v_trusted_delete_context')
      }
      expect(installed.undo_definition).toContain(
        'Cannot undo a completed SIE import with committed journal entries',
      )
      expect(installed.replace_definition).toContain(
        'Cannot replace a completed SIE import by deleting committed journal entries',
      )
      expect(installed.undo_definition).not.toContain(
        'DELETE FROM public.journal_entries',
      )
      expect(installed.replace_definition).not.toContain(
        'DELETE FROM public.journal_entries',
      )
      expect(installed.event_definition).toContain(
        'v_event_log_total_count',
      )
      expect(installed.event_definition).toContain(
        'projection integrity mismatch',
      )
      expect(installed.apply_definition).toContain(
        'supplier payment reversal blocked by live correction child',
      )
      expect(installed.apply_definition).toContain('FOR UPDATE')
      expect(installed.apply_definition).toContain('ORDER BY correction.id')
      expect(installed.apply_definition).toContain(
        'supplier-payment-reversal:',
      )
      expect(installed.apply_definition).toContain(
        'v_root_journal_entry_id',
      )
      expect(installed.apply_definition).toContain(
        't.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id',
      )
      expect(installed.apply_definition).toContain(
        't.journal_entry_id = p_original_journal_entry_id',
      )
      expect(installed.payment_retention_definition).toContain(
        'supplier invoice payment reversal correction ancestry is cyclic',
      )
      expect(installed.payment_retention_definition).toContain(
        'v_current_id = OLD.journal_entry_id',
      )
      const correctionConstraint = await client.query<{ present: boolean }>(
        `SELECT to_regclass(
           'public.uq_journal_entries_committed_correction_child'
         ) IS NOT NULL AS present`,
      )
      expect(correctionConstraint.rows).toEqual([{ present: true }])
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('rejects a second committed correction child before lineage becomes ambiguous', async () => {
    const tenant = await seedCompany()
    const originalId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'manual',
      entryDate: '2026-06-01',
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })

    await insertPostedCorrection({
      ...tenant,
      originalJournalEntryId: originalId,
      entryDate: '2026-06-02',
    })
    await expect(insertPostedCorrection({
      ...tenant,
      originalJournalEntryId: originalId,
      entryDate: '2026-06-03',
    })).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_journal_entries_committed_correction_child',
    })

    const children = await getPool().query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM public.journal_entries
        WHERE correction_of_id = $1
          AND source_type = 'correction'
          AND status IN ('posted', 'reversed')`,
      [originalId],
    )
    expect(children.rows).toEqual([{ count: 1 }])
  })

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
    })).rejects.toThrow(
      /idx_supplier_invoice_payments_tx_inv_unique|duplicate active supplier payment transaction allocation/i,
    )

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
      `SELECT status, paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount, paid_at,
              payment_journal_entry_id
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'overdue',
      paid_amount: 0,
      remaining_amount: 1000,
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

  it.each(['posted', 'draft'] as const)(
    'rejects a %s correction child before mutating reversal state',
    async (correctionStatus) => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -seeded.total,
      journalEntryId: seeded.journalEntryId,
    })
    const paymentId = await insertPayment({ ...seeded, transactionId })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET paid_at = '2026-06-01T12:00:00Z',
              payment_journal_entry_id = $1
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1,
              is_business = true,
              category = 'expense_other'
        WHERE id = $2`,
      [seeded.supplierInvoiceId, transactionId],
    )
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })
    if (correctionStatus === 'posted') {
      await insertPostedCorrection({
        ...seeded,
        originalJournalEntryId: seeded.journalEntryId,
        entryDate: '2026-06-03',
      })
    } else {
      await getPool().query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number,
            voucher_series, entry_date, description, source_type,
            correction_of_id, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-03',
                 'Payment correction in progress', 'correction', $5, 'draft')`,
        [
          randomUUID(),
          seeded.userId,
          seeded.companyId,
          seeded.fiscalPeriodId,
          seeded.journalEntryId,
        ],
      )
    }

    const loadState = async () => {
      const result = await getPool().query(
        `SELECT
           (
             SELECT to_jsonb(allocation_state)
               FROM (
                 SELECT reversed_at, reversed_by_journal_entry_id
                   FROM public.supplier_invoice_payments
                  WHERE id = $2
               ) allocation_state
           ) AS allocation,
           (
             SELECT to_jsonb(invoice_state)
               FROM (
                 SELECT status,
                        paid_amount::text AS paid_amount,
                        remaining_amount::text AS remaining_amount,
                        paid_at,
                        payment_journal_entry_id
                   FROM public.supplier_invoices
                  WHERE id = $3
               ) invoice_state
           ) AS invoice,
           (
             SELECT to_jsonb(transaction_state)
               FROM (
                 SELECT journal_entry_id, supplier_invoice_id, invoice_id,
                        is_business, category
                   FROM public.transactions
                  WHERE id = $4
               ) transaction_state
           ) AS transaction,
           (
             SELECT count(*)::integer
               FROM public.audit_log
              WHERE company_id = $1
           ) AS audit_count,
           (
             SELECT count(*)::integer
               FROM public.supplier_payment_reversal_event_outbox
              WHERE company_id = $1
           ) AS outbox_count,
           (
             SELECT count(*)::integer
               FROM public.event_log
              WHERE company_id = $1
           ) AS event_count,
           (
             SELECT count(*)::integer
               FROM public.webhook_deliveries
              WHERE company_id = $1
           ) AS delivery_count`,
        [
          seeded.companyId,
          paymentId,
          seeded.supplierInvoiceId,
          transactionId,
        ],
      )
      return result.rows[0]
    }

    const before = await loadState()
    await withUserContext(seeded.userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: stornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment reversal blocked by live correction child',
      })
    })

    expect(await loadState()).toEqual(before)
    expect(before).toMatchObject({
      allocation: {
        reversed_at: null,
        reversed_by_journal_entry_id: null,
      },
      invoice: {
        status: 'paid',
        paid_amount: '1000',
        remaining_amount: '0',
        paid_at: '2026-06-01T12:00:00+00:00',
        payment_journal_entry_id: seeded.journalEntryId,
      },
      transaction: {
        journal_entry_id: seeded.journalEntryId,
        supplier_invoice_id: seeded.supplierInvoiceId,
        is_business: true,
        category: 'expense_other',
      },
    })
  })

  it('cancels the live correction descendant only after draft siblings are cancelled', async () => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -seeded.total,
      journalEntryId: seeded.journalEntryId,
    })
    const paymentId = await insertPayment({ ...seeded, transactionId })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET paid_at = '2026-06-01T12:00:00Z',
              payment_journal_entry_id = $1
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1,
              is_business = true,
              category = 'expense_other'
        WHERE id = $2`,
      [seeded.supplierInvoiceId, transactionId],
    )

    const rootStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-01',
    })
    const correctionId = await insertPostedCorrection({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-03',
    })
    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = $1
        WHERE id = $2`,
      [correctionId, transactionId],
    )
    const draftSiblingId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number,
          voucher_series, entry_date, description, source_type,
          correction_of_id, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-04',
               'Cancelled correction construction artifact',
               'correction', $5, 'draft')`,
      [
        draftSiblingId,
        seeded.userId,
        seeded.companyId,
        seeded.fiscalPeriodId,
        seeded.journalEntryId,
      ],
    )
    const descendantStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: correctionId,
      entryDate: '2026-06-03',
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: correctionId,
          stornoJournalEntryId: descendantStornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment reversal blocked by live correction child',
      })
    })

    const unchanged = await getPool().query(
      `SELECT si.status,
              si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              si.payment_journal_entry_id,
              sip.reversed_at,
              sip.reversed_by_journal_entry_id,
              t.journal_entry_id AS transaction_journal_entry_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1 AND sip.id = $2`,
      [seeded.supplierInvoiceId, paymentId, transactionId],
    )
    expect(unchanged.rows).toEqual([expect.objectContaining({
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
      payment_journal_entry_id: seeded.journalEntryId,
      reversed_at: null,
      reversed_by_journal_entry_id: null,
      transaction_journal_entry_id: correctionId,
    })])

    await getPool().query(
      `UPDATE public.journal_entries
          SET status = 'cancelled'
        WHERE id = $1 AND status = 'draft'`,
      [draftSiblingId],
    )

    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = $1
        WHERE id = $2`,
      [rootStornoId, transactionId],
    )
    await withUserContext(seeded.userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: correctionId,
          stornoJournalEntryId: descendantStornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment reversal transaction ownership conflict',
      })
    })
    const rejectedPointerState = await getPool().query(
      `SELECT si.status,
              si.paid_amount::double precision AS paid_amount,
              sip.reversed_at,
              sip.reversed_by_journal_entry_id,
              t.journal_entry_id AS transaction_journal_entry_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1 AND sip.id = $2`,
      [seeded.supplierInvoiceId, paymentId, transactionId],
    )
    expect(rejectedPointerState.rows).toEqual([expect.objectContaining({
      status: 'paid',
      paid_amount: 1000,
      reversed_at: null,
      reversed_by_journal_entry_id: null,
      transaction_journal_entry_id: rootStornoId,
    })])
    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = $1
        WHERE id = $2`,
      [correctionId, transactionId],
    )

    await withUserContext(seeded.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: correctionId,
        stornoJournalEntryId: descendantStornoId,
      })
      const retry = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: correctionId,
        stornoJournalEntryId: descendantStornoId,
      })
      expect(first).toMatchObject({
        ok: true,
        status: 'applied',
        allocation_count: 1,
        invoice_count: 1,
        transaction_count: 1,
        event_publication: {
          status: 'published',
          event_log_count: 2,
        },
      })
      expect(retry).toMatchObject({
        ok: true,
        status: 'already_applied',
        event_publication: {
          status: 'already_published',
          event_log_count: 2,
        },
      })

      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: rootStornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment reversal blocked by live correction child',
      })

      const outboxIds = getEventOutboxIds(first)
      const events = await client.query<{
        event_type: string
        data: Record<string, unknown>
      }>(
        `SELECT event_type, data
           FROM public.event_log
          WHERE outbox_event_id = ANY($1::uuid[])
          ORDER BY event_type`,
        [outboxIds],
      )
      expect(events.rows).toEqual([
        expect.objectContaining({
          event_type: 'journal_entry.committed',
          data: { entry: expect.objectContaining({ id: descendantStornoId }) },
        }),
        expect.objectContaining({
          event_type: 'journal_entry.reversed',
          data: {
            originalEntry: expect.objectContaining({ id: correctionId }),
            reversalEntry: expect.objectContaining({ id: descendantStornoId }),
          },
        }),
      ])
    }, { commit: true })

    const restored = await getPool().query(
      `SELECT si.status,
              si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              si.paid_at,
              si.payment_journal_entry_id,
              sip.journal_entry_id AS allocation_journal_entry_id,
              sip.reversed_at,
              sip.reversed_by_journal_entry_id,
              t.journal_entry_id AS transaction_journal_entry_id,
              t.supplier_invoice_id AS transaction_supplier_invoice_id,
              t.is_business,
              t.category
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1 AND sip.id = $2`,
      [seeded.supplierInvoiceId, paymentId, transactionId],
    )
    expect(restored.rows).toEqual([expect.objectContaining({
      status: 'overdue',
      paid_amount: 0,
      remaining_amount: 1000,
      paid_at: null,
      payment_journal_entry_id: null,
      allocation_journal_entry_id: seeded.journalEntryId,
      reversed_by_journal_entry_id: descendantStornoId,
      transaction_journal_entry_id: null,
      transaction_supplier_invoice_id: null,
      is_business: null,
      category: null,
    })])
    expect(restored.rows[0].reversed_at.toISOString()).toBe(
      '2026-06-03T10:00:00.000Z',
    )

    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = $1
        WHERE id = $2`,
      [rootStornoId, transactionId],
    )
    await withUserContext(seeded.userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: correctionId,
          stornoJournalEntryId: descendantStornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment reversal transaction ownership conflict',
      })
    })

    const poisonedRetryState = await getPool().query(
      `SELECT si.paid_amount::double precision AS paid_amount,
              sip.reversed_by_journal_entry_id,
              t.journal_entry_id AS transaction_journal_entry_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1 AND sip.id = $2`,
      [seeded.supplierInvoiceId, paymentId, transactionId],
    )
    expect(poisonedRetryState.rows).toEqual([expect.objectContaining({
      paid_amount: 0,
      reversed_by_journal_entry_id: descendantStornoId,
      transaction_journal_entry_id: rootStornoId,
    })])
  })

  it('rejects cross-company correction ancestry before touching the foreign root', async () => {
    const foreign = await seedPaymentVoucher()
    const paymentId = await insertPayment(foreign)
    const own = await seedCompany()
    const correctionId = await insertPostedCorrection({
      ...own,
      originalJournalEntryId: foreign.journalEntryId,
      entryDate: '2026-06-03',
    })
    const descendantStornoId = await insertPostedStorno({
      ...own,
      originalJournalEntryId: correctionId,
      entryDate: '2026-06-03',
    })

    await withUserContext(own.userId, async (client) => {
      await expect(withErrorSavepoint(
        client,
        () => applySupplierPaymentReversal(client, {
          companyId: own.companyId,
          originalJournalEntryId: correctionId,
          stornoJournalEntryId: descendantStornoId,
        }),
      )).rejects.toMatchObject({
        code: '55000',
        message: 'supplier payment correction ancestry is missing or cross-company',
      })
    })

    const foreignState = await getPool().query(
      `SELECT si.status,
              si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              sip.reversed_at,
              sip.reversed_by_journal_entry_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
        WHERE si.id = $1 AND sip.id = $2`,
      [foreign.supplierInvoiceId, paymentId],
    )
    expect(foreignState.rows).toEqual([{
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
      reversed_at: null,
      reversed_by_journal_entry_id: null,
    }])
  })

  it('serializes concurrent retries for one correction-descendant cancellation', async () => {
    const seeded = await seedPaymentVoucher()
    await insertPayment(seeded)
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET paid_at = '2026-06-01T12:00:00Z',
              payment_journal_entry_id = $1
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-01',
    })
    const correctionId = await insertPostedCorrection({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-03',
    })
    const descendantStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: correctionId,
      entryDate: '2026-06-03',
    })

    const firstClient = await getPool().connect()
    const retryClient = await getPool().connect()
    try {
      for (const client of [firstClient, retryClient]) {
        await client.query('BEGIN')
        await client.query(
          `SELECT set_config(
             'request.jwt.claims',
             '{"role":"service_role"}',
             true
           )`,
        )
        await client.query(
          `SELECT set_config(
             'request.jwt.claim.role',
             'service_role',
             true
           )`,
        )
        await client.query('SET LOCAL ROLE service_role')
      }

      const first = await applySupplierPaymentReversal(firstClient, {
        companyId: seeded.companyId,
        originalJournalEntryId: correctionId,
        stornoJournalEntryId: descendantStornoId,
      })
      const retryPromise = applySupplierPaymentReversal(retryClient, {
        companyId: seeded.companyId,
        originalJournalEntryId: correctionId,
        stornoJournalEntryId: descendantStornoId,
      })
      await firstClient.query('COMMIT')
      const retry = await retryPromise
      await retryClient.query('COMMIT')

      expect(first).toMatchObject({ ok: true, status: 'applied' })
      expect(retry).toMatchObject({ ok: true, status: 'already_applied' })
    } catch (error) {
      await firstClient.query('ROLLBACK').catch(() => {})
      await retryClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      firstClient.release()
      retryClient.release()
    }

    const state = await getPool().query(
      `SELECT si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              count(*)::integer AS allocation_count,
              count(*) FILTER (
                WHERE sip.reversed_by_journal_entry_id = $2
              )::integer AS exact_reversal_count
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
        WHERE si.id = $1
        GROUP BY si.id`,
      [seeded.supplierInvoiceId, descendantStornoId],
    )
    expect(state.rows).toEqual([{
      paid_amount: 0,
      remaining_amount: 1000,
      allocation_count: 1,
      exact_reversal_count: 1,
    }])
  })

  it('locks allocation-linked transactions through descendant reversal', async () => {
    const seeded = await seedPaymentVoucher()
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -seeded.total,
      journalEntryId: seeded.journalEntryId,
    })
    await insertPayment({ ...seeded, transactionId })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET paid_at = '2026-06-01T12:00:00Z',
              payment_journal_entry_id = $1
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1,
              is_business = true,
              category = 'expense_other'
        WHERE id = $2`,
      [seeded.supplierInvoiceId, transactionId],
    )
    const rootStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-01',
    })
    const correctionId = await insertPostedCorrection({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      entryDate: '2026-06-03',
    })
    await getPool().query(
      `UPDATE public.transactions
          SET journal_entry_id = $1
        WHERE id = $2`,
      [correctionId, transactionId],
    )
    const descendantStornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: correctionId,
      entryDate: '2026-06-03',
    })

    const relinkClient = await getPool().connect()
    const reversalClient = await getPool().connect()
    try {
      await relinkClient.query('BEGIN')
      await relinkClient.query(
        `UPDATE public.transactions
            SET journal_entry_id = $1
          WHERE id = $2`,
        [rootStornoId, transactionId],
      )

      await reversalClient.query('BEGIN')
      await reversalClient.query(
        `SELECT set_config(
           'request.jwt.claims',
           '{"role":"service_role"}',
           true
         )`,
      )
      await reversalClient.query(
        `SELECT set_config(
           'request.jwt.claim.role',
           'service_role',
           true
         )`,
      )
      await reversalClient.query('SET LOCAL ROLE service_role')

      const reversalPromise = applySupplierPaymentReversal(reversalClient, {
        companyId: seeded.companyId,
        originalJournalEntryId: correctionId,
        stornoJournalEntryId: descendantStornoId,
      })
      const whileLocked = await Promise.race([
        reversalPromise.then(() => 'completed'),
        new Promise<'blocked'>((resolveBlocked) =>
          setTimeout(() => resolveBlocked('blocked'), 150),
        ),
      ])
      expect(whileLocked).toBe('blocked')

      await relinkClient.query('ROLLBACK')
      const result = await reversalPromise
      await reversalClient.query('COMMIT')
      expect(result).toMatchObject({
        ok: true,
        status: 'applied',
        transaction_count: 1,
      })
    } catch (error) {
      await relinkClient.query('ROLLBACK').catch(() => {})
      await reversalClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      relinkClient.release()
      reversalClient.release()
    }

    const lockedState = await getPool().query(
      `SELECT si.paid_amount::double precision AS paid_amount,
              sip.reversed_by_journal_entry_id,
              t.journal_entry_id,
              t.supplier_invoice_id
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip
           ON sip.supplier_invoice_id = si.id
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1
          AND sip.journal_entry_id = $2`,
      [seeded.supplierInvoiceId, seeded.journalEntryId, transactionId],
    )
    expect(lockedState.rows).toEqual([expect.objectContaining({
      paid_amount: 0,
      reversed_by_journal_entry_id: descendantStornoId,
      journal_entry_id: null,
      supplier_invoice_id: null,
    })])
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
      `SELECT si.status, si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
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
      paid_amount: 0,
      remaining_amount: 1000,
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

      const eventOutboxIds = getEventOutboxIds(first)
      const events = await client.query<{
        event_type: string
        entity_id: string
        data: Record<string, unknown>
      }>(
        `SELECT event_type, entity_id, data
           FROM public.event_log
          WHERE outbox_event_id = ANY($1::uuid[])
          ORDER BY event_type`,
        [eventOutboxIds],
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
        [eventOutboxIds],
      )
      expect(deliveries.rows.map((row) => row.webhook_id)).toEqual([
        committedWebhookId,
        reversedWebhookId,
      ])

      const invoice = await client.query(
        `SELECT paid_amount::double precision AS paid_amount,
                remaining_amount::double precision AS remaining_amount
           FROM public.supplier_invoices
          WHERE id = $1`,
        [seeded.supplierInvoiceId],
      )
      expect(invoice.rows).toEqual([{ paid_amount: 0, remaining_amount: 1000 }])
    })
  })

  it('accepts an exact retry after the 30-day event-log projection expires', async () => {
    const seeded = await seedPaymentVoucher()
    await insertPayment(seeded)
    await insertWebhook(seeded.companyId, 'journal_entry.committed')
    await insertWebhook(seeded.companyId, 'journal_entry.reversed')
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    let outboxIds: string[] = []
    await withUserContext(seeded.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      outboxIds = getEventOutboxIds(first)
    }, { commit: true })

    // Mirrors the privileged daily retention job, not an authenticated user.
    await getPool().query(
      `DELETE FROM public.event_log
        WHERE outbox_event_id = ANY($1::uuid[])`,
      [outboxIds],
    )

    await withUserContext(seeded.userId, async (client) => {
      const retry = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      expect(retry).toMatchObject({
        ok: true,
        status: 'already_applied',
        event_publication: {
          status: 'already_published',
          event_log_count: 0,
          webhook_delivery_count: 2,
        },
      })
    })

    const durable = await getPool().query<{
      outbox_count: number
      published_count: number
      delivery_count: number
    }>(
      `SELECT
         (SELECT count(*)::integer
            FROM public.supplier_payment_reversal_event_outbox
           WHERE id = ANY($1::uuid[])) AS outbox_count,
         (SELECT count(*)::integer
            FROM public.supplier_payment_reversal_event_outbox
           WHERE id = ANY($1::uuid[])
             AND published_at IS NOT NULL) AS published_count,
         (SELECT count(*)::integer
            FROM public.webhook_deliveries
           WHERE outbox_event_id = ANY($1::uuid[])) AS delivery_count`,
      [outboxIds],
    )
    expect(durable.rows).toEqual([{
      outbox_count: 2,
      published_count: 2,
      delivery_count: 2,
    }])
  })

  it('rejects a retry when an outbox projection row is contradictory', async () => {
    const seeded = await seedPaymentVoucher()
    await insertPayment(seeded)
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })

    let outboxIds: string[] = []
    await withUserContext(seeded.userId, async (client) => {
      const first = await applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })
      outboxIds = getEventOutboxIds(first)
    }, { commit: true })

    // event_log rows are append-only but intentionally deletable by the
    // privileged retention job. Recreate one removed projection incorrectly
    // through that legitimate delete-and-insert boundary, without disabling
    // the production immutability trigger.
    const corruptedProjection = await getPool().query(
      `WITH removed AS (
         DELETE FROM public.event_log
          WHERE outbox_event_id = $2
          RETURNING user_id, company_id, event_type, data, created_at,
                    outbox_event_id
       )
       INSERT INTO public.event_log (
         user_id, company_id, event_type, entity_id, data, created_at,
         outbox_event_id
       )
       SELECT user_id, company_id, event_type, $1::uuid, data, created_at,
              outbox_event_id
       FROM removed`,
      [seeded.journalEntryId, outboxIds[0]],
    )
    expect(corruptedProjection.rowCount).toBe(1)

    await withUserContext(seeded.userId, async (client) => {
      await expect(
        applySupplierPaymentReversal(client, {
          companyId: seeded.companyId,
          originalJournalEntryId: seeded.journalEntryId,
          stornoJournalEntryId: stornoId,
        }),
      ).rejects.toMatchObject({
        code: '55000',
        message: expect.stringMatching(/projection integrity mismatch/i),
      })
    })

    const projection = await getPool().query<{
      total_count: number
      exact_count: number
    }>(
      `SELECT
         count(*)::integer AS total_count,
         count(*) FILTER (
           WHERE e.company_id = o.company_id
             AND e.user_id = o.user_id
             AND e.event_type = o.event_type
             AND e.entity_id = o.reversal_journal_entry_id
             AND e.data = o.payload - 'userId' - 'companyId'
         )::integer AS exact_count
       FROM public.event_log e
       JOIN public.supplier_payment_reversal_event_outbox o
         ON o.id = e.outbox_event_id
       WHERE o.id = ANY($1::uuid[])`,
      [outboxIds],
    )
    expect(projection.rows).toEqual([{ total_count: 2, exact_count: 1 }])

    const state = await getPool().query<{
      status: string
      paid_amount: number
      remaining_amount: number
    }>(
      `SELECT status,
              paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(state.rows).toEqual([{
      status: 'overdue',
      paid_amount: 0,
      remaining_amount: 1000,
    }])
  })

  it('rejects a mismatched storno and leaves supplier state unchanged', async () => {
    const seeded = await seedPaymentVoucher()
    const paymentId = await insertPayment(seeded)
    await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
    })
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

  it('recovers a partial v1 payment without an allocation and releases only its owned transaction', async () => {
    const seeded = await seedV1PaymentWithoutAllocation({
      paymentAmount: 400,
      withTransaction: true,
    })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: seeded.paymentAmount,
    })

    const result = await withUserContext(seeded.userId, async (client) =>
      applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      }), { commit: true })

    expect(result).toMatchObject({
      ok: true,
      status: 'applied_v1_recovery',
      allocation_count: 0,
      invoice_count: 1,
      transaction_count: 1,
    })
    const invoice = await getPool().query(
      `SELECT status, paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount, paid_at,
              payment_journal_entry_id
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'overdue',
      paid_amount: 0,
      remaining_amount: 1000,
      paid_at: null,
      payment_journal_entry_id: null,
    }])
    const transaction = await getPool().query(
      `SELECT journal_entry_id, supplier_invoice_id, is_business, category
         FROM public.transactions
        WHERE id = $1`,
      [seeded.transactionId],
    )
    expect(transaction.rows).toEqual([{
      journal_entry_id: null,
      supplier_invoice_id: null,
      is_business: null,
      category: null,
    }])
    const events = await getPool().query(
      `SELECT count(*)::integer AS outbox_count,
              count(*) FILTER (WHERE published_at IS NOT NULL)::integer AS published_count
         FROM public.supplier_payment_reversal_event_outbox
        WHERE company_id = $1
          AND original_journal_entry_id = $2
          AND reversal_journal_entry_id = $3`,
      [seeded.companyId, seeded.journalEntryId, stornoId],
    )
    expect(events.rows).toEqual([{ outbox_count: 2, published_count: 2 }])
  })

  it('restores the prior partial state once when a final v1 payment is retried', async () => {
    const seeded = await seedV1PaymentWithoutAllocation({
      priorPaidAmount: 300,
      paymentAmount: 700,
    })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: seeded.paymentAmount,
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
      expect(first).toMatchObject({ ok: true, status: 'applied_v1_recovery' })
      expect(second).toMatchObject({
        ok: true,
        status: 'already_applied_v1_recovery',
      })
    }, { commit: true })

    const invoice = await getPool().query(
      `SELECT status, paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount, paid_at,
              payment_journal_entry_id
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'partially_paid',
      paid_amount: 300,
      remaining_amount: 700,
      paid_at: null,
      payment_journal_entry_id: null,
    }])
    const markers = await getPool().query(
      `SELECT count(*)::integer AS count
         FROM public.supplier_payment_reversal_event_outbox
        WHERE company_id = $1
          AND original_journal_entry_id = $2
          AND reversal_journal_entry_id = $3`,
      [seeded.companyId, seeded.journalEntryId, stornoId],
    )
    expect(markers.rows).toEqual([{ count: 2 }])
  })

  it('rejects conflicting v1 invoice state without releasing pointers or publishing events', async () => {
    const seeded = await seedV1PaymentWithoutAllocation({
      paymentAmount: 400,
      withTransaction: true,
    })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET remaining_amount = 500
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: seeded.paymentAmount,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })).rejects.toThrow(/invoice state conflict/i)
    }, { commit: true })

    const state = await getPool().query(
      `SELECT si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              si.payment_journal_entry_id,
              t.journal_entry_id AS transaction_journal_entry_id,
              (
                SELECT count(*)::integer
                  FROM public.supplier_payment_reversal_event_outbox o
                 WHERE o.original_journal_entry_id = $2
              ) AS marker_count
         FROM public.supplier_invoices si
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $1`,
      [seeded.supplierInvoiceId, seeded.journalEntryId, seeded.transactionId],
    )
    expect(state.rows).toEqual([{
      paid_amount: 400,
      remaining_amount: 500,
      payment_journal_entry_id: seeded.journalEntryId,
      transaction_journal_entry_id: seeded.journalEntryId,
      marker_count: 0,
    }])
  })

  it('rejects an ambiguous 2440 journal shape without changing invoice state', async () => {
    const seeded = await seedV1PaymentWithoutAllocation({
      paymentAmount: 400,
      lines: [
        { accountNumber: '2440', debitAmount: 300, creditAmount: 0 },
        { accountNumber: '2440', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 400 },
      ],
    })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: seeded.paymentAmount,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })).rejects.toThrow(/journal line shape is ambiguous/i)
    }, { commit: true })

    const state = await getPool().query(
      `SELECT si.status, si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              si.payment_journal_entry_id,
              (
                SELECT count(*)::integer
                  FROM public.supplier_payment_reversal_event_outbox o
                 WHERE o.original_journal_entry_id = $2
              ) AS marker_count
         FROM public.supplier_invoices si
        WHERE si.id = $1`,
      [seeded.supplierInvoiceId, seeded.journalEntryId],
    )
    expect(state.rows).toEqual([{
      status: 'partially_paid',
      paid_amount: 400,
      remaining_amount: 600,
      payment_journal_entry_id: seeded.journalEntryId,
      marker_count: 0,
    }])
  })

  it('rejects cross-tenant transaction ownership without changing either tenant', async () => {
    const seeded = await seedV1PaymentWithoutAllocation({ paymentAmount: 400 })
    const foreign = await seedCompany()
    const foreignTransactionId = await insertTransaction({
      ...foreign,
      journalEntryId: seeded.journalEntryId,
    })
    const stornoId = await insertPostedStorno({
      ...seeded,
      originalJournalEntryId: seeded.journalEntryId,
      amount: seeded.paymentAmount,
    })

    await withUserContext(seeded.userId, async (client) => {
      await expect(applySupplierPaymentReversal(client, {
        companyId: seeded.companyId,
        originalJournalEntryId: seeded.journalEntryId,
        stornoJournalEntryId: stornoId,
      })).rejects.toThrow(/transaction ownership conflict/i)
    }, { commit: true })

    const transaction = await getPool().query(
      `SELECT company_id, journal_entry_id
         FROM public.transactions
        WHERE id = $1`,
      [foreignTransactionId],
    )
    expect(transaction.rows).toEqual([{
      company_id: foreign.companyId,
      journal_entry_id: seeded.journalEntryId,
    }])
    const invoice = await getPool().query(
      `SELECT paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount,
              payment_journal_entry_id
         FROM public.supplier_invoices
        WHERE id = $1`,
      [seeded.supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      paid_amount: 400,
      remaining_amount: 600,
      payment_journal_entry_id: seeded.journalEntryId,
    }])
  })

  it('continues to reject allocation-free manual and unlinked ordinary vouchers', async () => {
    const tenant = await seedCompany()
    const supplierInvoiceId = await insertSupplierInvoice({
      userId: tenant.userId,
      companyId: tenant.companyId,
    })
    const manualId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'manual',
      sourceId: supplierInvoiceId,
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const manualStornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: manualId,
    })
    const ordinaryId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'supplier_invoice_paid',
      sourceId: null,
      lines: [
        { accountNumber: '2440', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const ordinaryStornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: ordinaryId,
    })

    await withUserContext(tenant.userId, async (client) => {
      await expect(applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: manualId,
        stornoJournalEntryId: manualStornoId,
      })).rejects.toThrow(/manual supplier payment reversal has no retained allocations/i)
    }, { commit: true })
    await withUserContext(tenant.userId, async (client) => {
      await expect(applySupplierPaymentReversal(client, {
        companyId: tenant.companyId,
        originalJournalEntryId: ordinaryId,
        stornoJournalEntryId: ordinaryStornoId,
      })).rejects.toThrow(/has no source invoice/i)
    }, { commit: true })

    const invoice = await getPool().query(
      `SELECT status, paid_amount::double precision AS paid_amount,
              remaining_amount::double precision AS remaining_amount
         FROM public.supplier_invoices
        WHERE id = $1`,
      [supplierInvoiceId],
    )
    expect(invoice.rows).toEqual([{
      status: 'paid',
      paid_amount: 1000,
      remaining_amount: 0,
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

  it('rejects an admin physically deleting a posted supplier payment before any state mutation', async () => {
    const seeded = await seedPaymentVoucher()
    const adminId = await insertAuthUser()
    await insertCompanyMember({
      companyId: seeded.companyId,
      userId: adminId,
      role: 'admin',
    })
    await getPool().query(
      `UPDATE public.supplier_invoices
          SET payment_journal_entry_id = $1,
              paid_at = '2026-06-01T12:00:00Z',
              due_date = '2099-12-31'
        WHERE id = $2`,
      [seeded.journalEntryId, seeded.supplierInvoiceId],
    )
    const transactionId = await insertTransaction({
      ...seeded,
      amount: -seeded.total,
      journalEntryId: seeded.journalEntryId,
    })
    await getPool().query(
      `UPDATE public.transactions
          SET supplier_invoice_id = $1,
              is_business = true,
              category = 'expense_other'
        WHERE id = $2`,
      [seeded.supplierInvoiceId, transactionId],
    )
    const paymentId = await insertPayment({ ...seeded, transactionId })

    await withUserContext(adminId, async (client) => {
      await expect(deleteLastVoucher(
        client,
        seeded.companyId,
        seeded.journalEntryId,
      )).rejects.toThrow(/Only genuine draft journal entries/i)
    }, { commit: true })

    const state = await getPool().query(
      `SELECT si.status,
              si.paid_amount::double precision AS paid_amount,
              si.remaining_amount::double precision AS remaining_amount,
              si.payment_journal_entry_id,
              sip.journal_entry_id AS allocation_journal_entry_id,
              sip.reversed_at,
              t.journal_entry_id AS transaction_journal_entry_id,
              t.supplier_invoice_id AS transaction_supplier_invoice_id,
              t.is_business,
              t.category,
              (
                SELECT count(*)::integer
                  FROM public.journal_entries je
                 WHERE je.id = $1
              ) AS journal_count,
              (
                SELECT count(*)::integer
                  FROM public.audit_log audit
                 WHERE audit.table_name = 'journal_entries'
                   AND audit.record_id = $1
                   AND audit.action = 'DELETE'
              ) AS delete_audit_count
         FROM public.supplier_invoices si
         JOIN public.supplier_invoice_payments sip ON sip.id = $2
         JOIN public.transactions t ON t.id = $3
        WHERE si.id = $4`,
      [
        seeded.journalEntryId,
        paymentId,
        transactionId,
        seeded.supplierInvoiceId,
      ],
    )
    expect(state.rows).toEqual([{
      status: 'paid',
      paid_amount: seeded.total,
      remaining_amount: 0,
      payment_journal_entry_id: seeded.journalEntryId,
      allocation_journal_entry_id: seeded.journalEntryId,
      reversed_at: null,
      transaction_journal_entry_id: seeded.journalEntryId,
      transaction_supplier_invoice_id: seeded.supplierInvoiceId,
      is_business: true,
      category: 'expense_other',
      journal_count: 1,
      delete_audit_count: 0,
    }])
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
  it('returns only authenticated company roots and preserves requested-root evidence', async () => {
    const first = await seedCompany()
    const second = await seedCompany()
    const firstRoot = await insertPostedJournalEntry({
      ...first,
      sourceType: 'supplier_invoice_paid',
      entryDate: '2026-06-01',
    })
    const secondRoot = await insertPostedJournalEntry({
      ...second,
      sourceType: 'supplier_invoice_paid',
      entryDate: '2026-06-01',
    })

    await withUserContext(first.userId, async (client) => {
      const lineage = await getSupplierPaymentLineage(
        client,
        first.companyId,
        [firstRoot, secondRoot],
      )
      expect(lineage.requested_root_count).toBe(2)
      expect(lineage.rows).toEqual([
        expect.objectContaining({
          root_id: firstRoot,
          id: firstRoot,
          edge_kind: 'root',
          depth: 0,
          cycle: false,
        }),
      ])

      const otherCompany = await getSupplierPaymentLineage(
        client,
        second.companyId,
        [secondRoot],
      )
      expect(otherCompany).toEqual({
        requested_root_count: 1,
        rows: [],
      })
    })
  })

  it('returns correction-of-correction and exact storno lineage', async () => {
    const tenant = await seedCompany()
    const rootId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'supplier_invoice_paid',
      entryDate: '2026-06-01',
    })
    const firstStornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: rootId,
      entryDate: '2026-06-01',
    })
    const firstCorrectionId = await insertPostedCorrection({
      ...tenant,
      originalJournalEntryId: rootId,
      entryDate: '2026-06-03',
    })
    const secondStornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: firstCorrectionId,
      entryDate: '2026-06-03',
    })
    const secondCorrectionId = await insertPostedCorrection({
      ...tenant,
      originalJournalEntryId: firstCorrectionId,
      entryDate: '2026-06-04',
    })
    const draftArtifactId = randomUUID()
    const cancelledArtifactId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number,
          voucher_series, entry_date, description, source_type,
          correction_of_id, status)
       VALUES
         ($1, $3, $4, $5, 0, 'A', '2026-06-05',
          'Draft correction artifact', 'correction', $6, 'draft'),
         ($2, $3, $4, $5, 0, 'A', '2026-06-06',
          'Cancelled correction artifact', 'correction', $6, 'cancelled')`,
      [
        draftArtifactId,
        cancelledArtifactId,
        tenant.userId,
        tenant.companyId,
        tenant.fiscalPeriodId,
        secondCorrectionId,
      ],
    )

    await withUserContext(tenant.userId, async (client) => {
      const lineage = await getSupplierPaymentLineage(
        client,
        tenant.companyId,
        [rootId],
      )
      expect(lineage.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: rootId,
          edge_kind: 'root',
          parent_id: null,
          depth: 0,
        }),
        expect.objectContaining({
          id: firstStornoId,
          edge_kind: 'storno',
          parent_id: rootId,
          depth: 1,
        }),
        expect.objectContaining({
          id: firstCorrectionId,
          edge_kind: 'correction',
          parent_id: rootId,
          depth: 1,
        }),
        expect.objectContaining({
          id: secondStornoId,
          edge_kind: 'storno',
          parent_id: firstCorrectionId,
          depth: 2,
        }),
        expect.objectContaining({
          id: secondCorrectionId,
          edge_kind: 'correction',
          parent_id: firstCorrectionId,
          depth: 2,
        }),
      ]))
      expect(lineage.rows).toHaveLength(5)
      expect(lineage.rows.map((row) => row.id)).not.toContain(draftArtifactId)
      expect(lineage.rows.map((row) => row.id)).not.toContain(cancelledArtifactId)
    })
  })

  it('returns a plain storno as a leaf without inventing a correction', async () => {
    const tenant = await seedCompany()
    const rootId = await insertPostedJournalEntry({
      ...tenant,
      sourceType: 'supplier_invoice_paid',
      entryDate: '2026-06-01',
    })
    const stornoId = await insertPostedStorno({
      ...tenant,
      originalJournalEntryId: rootId,
    })

    await withUserContext(tenant.userId, async (client) => {
      const lineage = await getSupplierPaymentLineage(
        client,
        tenant.companyId,
        [rootId],
      )
      expect(lineage.rows).toEqual([
        expect.objectContaining({
          id: rootId,
          edge_kind: 'root',
          cycle: false,
        }),
        expect.objectContaining({
          id: stornoId,
          edge_kind: 'storno',
          parent_id: rootId,
          cycle: false,
        }),
      ])
    })
  })

  it('exposes a malformed correction cycle without recursive overflow', async () => {
    const tenant = await seedCompany()
    const cycleRootId = randomUUID()
    const cycleChildId = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number,
            voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'Cycle root',
                 'supplier_invoice_paid', 'draft'),
                ($5, $2, $3, $4, 0, 'A', '2026-06-02', 'Cycle child',
                 'correction', 'draft')`,
        [
          cycleRootId,
          tenant.userId,
          tenant.companyId,
          tenant.fiscalPeriodId,
          cycleChildId,
        ],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount,
            currency, sort_order)
         VALUES
           ($1, '2440', 1000, 0, 'SEK', 0),
           ($1, '1930', 0, 1000, 'SEK', 1),
           ($2, '2440', 1000, 0, 'SEK', 0),
           ($2, '1930', 0, 1000, 'SEK', 1)`,
        [cycleRootId, cycleChildId],
      )
      await client.query(
        `UPDATE public.journal_entries
            SET correction_of_id = CASE
              WHEN id = $1 THEN $2::uuid
              ELSE $1::uuid
            END
          WHERE id IN ($1, $2)`,
        [cycleRootId, cycleChildId],
      )
      await client.query(
        `UPDATE public.journal_entries
            SET status = CASE
              WHEN id = $1 THEN 'reversed'
              ELSE 'posted'
            END,
                committed_at = '2026-06-02T10:00:00Z'
          WHERE id IN ($1, $2)`,
        [cycleRootId, cycleChildId],
      )
      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    await withUserContext(tenant.userId, async (client) => {
      const cycle = await getSupplierPaymentLineage(
        client,
        tenant.companyId,
        [cycleRootId],
      )
      expect(cycle.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: cycleRootId,
          parent_id: cycleChildId,
          edge_kind: 'correction',
          depth: 2,
          cycle: true,
        }),
      ]))
      expect(cycle.rows).toHaveLength(3)
    })
  })

  it('accepts 32 corrections plus storno and rejects a 33rd correction', async () => {
    const tenant = await seedCompany()
    const terminalStornoId = randomUUID()
    const ids = Array.from(
      { length: MAX_LINEAGE_DEPTH + 2 },
      () => randomUUID(),
    )
    const seedClient = await getPool().connect()
    try {
      await seedClient.query('BEGIN')
      await seedClient.query('SET LOCAL session_replication_role = replica')
      await seedClient.query(
        `WITH nodes AS (
           SELECT node.id, node.ordinality
           FROM unnest($1::uuid[]) WITH ORDINALITY AS node(id, ordinality)
         )
         INSERT INTO public.journal_entries (
           id,
           user_id,
           company_id,
           fiscal_period_id,
           voucher_number,
           voucher_series,
           entry_date,
           description,
           source_type,
           status,
           correction_of_id,
           committed_at
         )
         SELECT
           nodes.id,
           $2,
           $3,
           $4,
           0,
           'A',
           '2026-06-01',
           'Lineage depth fixture',
           CASE WHEN nodes.ordinality = 1
             THEN 'supplier_invoice_paid'
             ELSE 'correction'
           END,
           'reversed',
           CASE WHEN nodes.ordinality = 1
             THEN NULL
             ELSE ($1::uuid[])[(nodes.ordinality - 1)::integer]
           END,
           '2026-06-01T10:00:00Z'
         FROM nodes`,
        [ids, tenant.userId, tenant.companyId, tenant.fiscalPeriodId],
      )
      await seedClient.query(
        `INSERT INTO public.journal_entries (
           id,
           user_id,
           company_id,
           fiscal_period_id,
           voucher_number,
           voucher_series,
           entry_date,
           description,
           source_type,
           status,
           reverses_id,
           committed_at
         ) VALUES (
           $1, $2, $3, $4, 0, 'A', '2026-06-02',
           'Terminal storno after maximum correction depth',
           'storno', 'posted', $5, '2026-06-02T10:00:00Z'
         )`,
        [
          terminalStornoId,
          tenant.userId,
          tenant.companyId,
          tenant.fiscalPeriodId,
          ids.at(-1),
        ],
      )
      await seedClient.query('COMMIT')
    } catch (error) {
      await seedClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      seedClient.release()
    }

    await withUserContext(tenant.userId, async (client) => {
      const accepted = await getSupplierPaymentLineage(
        client,
        tenant.companyId,
        [ids[1]!],
      )
      expect(accepted.rows).toHaveLength(MAX_LINEAGE_DEPTH + 2)
      expect(Math.max(...accepted.rows.map((row) => row.depth as number)))
        .toBe(MAX_LINEAGE_DEPTH + 1)
      expect(accepted.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: terminalStornoId,
          parent_id: ids.at(-1),
          edge_kind: 'storno',
          depth: MAX_LINEAGE_DEPTH + 1,
        }),
      ]))

      await expect(getSupplierPaymentLineage(
        client,
        tenant.companyId,
        [ids[0]!],
      )).rejects.toThrow(
        `supplier payment lineage exceeds maximum correction depth of ${MAX_LINEAGE_DEPTH}`,
      )
    })
  })

  it('rejects committed lineage above the emitted-row cap', async () => {
    const tenant = await seedCompany()
    const rootId = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        `INSERT INTO public.journal_entries (
           id,
           user_id,
           company_id,
           fiscal_period_id,
           voucher_number,
           voucher_series,
           entry_date,
           description,
           source_type,
           status,
           committed_at
         ) VALUES (
           $1,
           $2,
           $3,
           $4,
           0,
           'A',
           '2026-06-01',
           'Lineage row-cap root',
           'supplier_invoice_paid',
           'reversed',
           '2026-06-01T10:00:00Z'
         )`,
        [rootId, tenant.userId, tenant.companyId, tenant.fiscalPeriodId],
      )
      await client.query(
        `INSERT INTO public.journal_entries (
           id,
           user_id,
           company_id,
           fiscal_period_id,
           voucher_number,
           voucher_series,
           entry_date,
           description,
           source_type,
           status,
           reverses_id,
           committed_at
         )
         SELECT
           gen_random_uuid(),
           $2,
           $3,
           $4,
           0,
           'A',
           '2026-06-02',
           'Lineage row-cap storno',
           'storno',
           'posted',
           $1,
           '2026-06-02T10:00:00Z'
         FROM generate_series(1, $5::integer)`,
        [
          rootId,
          tenant.userId,
          tenant.companyId,
          tenant.fiscalPeriodId,
          MAX_LINEAGE_ROWS,
        ],
      )
      await client.query('SET LOCAL session_replication_role = origin')
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: tenant.userId, role: 'authenticated' })],
      )
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true)`,
        [tenant.userId],
      )
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`,
      )
      await client.query('SET LOCAL ROLE authenticated')
      await client.query('SAVEPOINT lineage_row_cap')

      await expect(client.query(
        `SELECT public.get_supplier_payment_lineage($1, $2::uuid[])`,
        [tenant.companyId, [rootId]],
      )).rejects.toThrow(
        `supplier payment lineage exceeds maximum emitted row count of ${MAX_LINEAGE_ROWS}`,
      )
      await client.query('ROLLBACK TO SAVEPOINT lineage_row_cap')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }, 60_000)

  it('rejects null roots, null elements, and oversized root arrays', async () => {
    const tenant = await seedCompany()
    await expect(getPool().query(
      `SELECT public.get_supplier_payment_lineage($1, NULL::uuid[])`,
      [tenant.companyId],
    )).rejects.toThrow(/roots are required/i)
    await expect(getPool().query(
      `SELECT public.get_supplier_payment_lineage(
         $1,
         ARRAY[NULL]::uuid[]
       )`,
      [tenant.companyId],
    )).rejects.toThrow(/cannot contain null/i)
    await expect(getPool().query(
      `SELECT public.get_supplier_payment_lineage(
         $1,
         array_fill($2::uuid, ARRAY[20001])
       )`,
      [tenant.companyId, randomUUID()],
    )).rejects.toThrow(/at most 20000 roots/i)
  })

  it('pins the lineage RPC invoker mode, search path, and grants', async () => {
    const signature = 'public.get_supplier_payment_lineage(uuid,uuid[])'
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
      prosecdef: false,
      proconfig: ['search_path=pg_catalog, public'],
      anon_exec: false,
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
    }])
  })


  it('pins the exact atomic RPC signature, security mode, and grants', async () => {
    const signature =
      'public.apply_supplier_payment_reversal(uuid,uuid,uuid)'
    const meta = await getPool().query(
      `SELECT p.prosecdef,
              p.proconfig,
              pg_get_userbyid(p.proowner) AS owner,
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
      owner: 'postgres',
      anon_exec: false,
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
    }])
  })
})
