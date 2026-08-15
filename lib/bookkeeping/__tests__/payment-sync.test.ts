import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  applySupplierPaymentReversal,
  isPaymentSourceType,
  resolveSupplierPaymentLineage,
  syncInvoiceStatusFromPaymentEntry,
} from '@/lib/bookkeeping/payment-sync'
import {
  BookkeepingDatabaseError,
  DurableAccountingIdentityError,
} from '@/lib/bookkeeping/errors'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type {
  DurableJournalReversalOutcome,
  JournalEntry,
  SupplierPaymentLineage,
} from '@/types'

/**
 * A Supabase mock that records the table + method + args of every chained call
 * (the shared createQueuedMockSupabase only records `from()` table names). Lets
 * us assert on the actual UPDATE/DELETE payloads, which is what the reversal
 * restore (remaining_amount reset, payment-row delete, tx release) hinges on.
 */
type RecordedCall = {
  table: string
  ops: Array<{ method: string; args: unknown[] }>
}
function createRecordingSupabase(queue: Array<{ data?: unknown; error?: unknown }>) {
  const calls: RecordedCall[] = []
  let i = 0
  const from = vi.fn((table: string) => {
    const result = queue[i++] ?? { data: null, error: null }
    const rec: RecordedCall = { table, ops: [] }
    calls.push(rec)
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return (...args: unknown[]) => {
            rec.ops.push({ method: String(prop), args })
            return chain
          }
        },
      },
    )
    return chain
  })
  const updatePayload = (table: string): Record<string, unknown> | undefined => {
    const rec = calls.find((c) => c.table === table && c.ops.some((o) => o.method === 'update'))
    return rec?.ops.find((o) => o.method === 'update')?.args[0] as Record<string, unknown> | undefined
  }
  const tablesUpdated = (table: string) => calls.filter((c) => c.table === table && c.ops.some((o) => o.method === 'update'))
  const wasDeleted = (table: string) => calls.some((c) => c.table === table && c.ops.some((o) => o.method === 'delete'))
  return { supabase: { from } as never, calls, updatePayload, tablesUpdated, wasDeleted }
}

describe('isPaymentSourceType', () => {
  it.each([
    'invoice_paid',
    'invoice_cash_payment',
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
  ])('recognises %s as payment', (sourceType) => {
    expect(isPaymentSourceType(sourceType)).toBe(true)
  })

  it.each(['manual', 'invoice_created', 'supplier_invoice_registered', '', null, undefined])(
    'rejects %s',
    (sourceType) => {
      expect(isPaymentSourceType(sourceType)).toBe(false)
    }
  )
})

describe('syncInvoiceStatusFromPaymentEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function entry(overrides: Partial<JournalEntry> = {}): Pick<JournalEntry, 'id' | 'source_type' | 'source_id'> {
    return {
      id: 'entry-1',
      source_type: 'supplier_invoice_paid',
      source_id: 'supplier-invoice-1',
      ...overrides,
    } as Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
  }

  it('is a no-op when source_type is not a payment', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'manual' as JournalEntry['source_type'] })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a no-op when source_id is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_id: null })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })


  it('routes customer invoice entries through the invoices table', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      { data: { paid_amount: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'invoice_payments', // select amount
      'invoices', // select
      'invoices', // update status/paid/remaining
      'invoice_payments', // select transaction_id
      'invoice_payments', // delete payment row
      'transactions', // release linked bank line
    ])
  })

  it('handles invoice_cash_payment the same way as invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 500 } },
      { data: { paid_amount: 500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('invoice_payments')
    expect(fromCalls[1]).toBe('invoices')
  })


  // Regression for the stuck-invoice deadlock (F-2026080): reversing a cash
  // payment left the invoice at status='paid' / remaining_amount=total because
  // the customer branch never reset remaining_amount. The cash path has no
  // invoice_payments row, so the full paid_amount is reverted.
  it('customer cash-payment reversal resets paid_amount, remaining_amount and status', async () => {
    const { supabase, updatePayload, wasDeleted } = createRecordingSupabase([
      { data: null }, // invoice_payments select amount → none (cash entry)
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' }),
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'sent',
      paid_at: null,
      paid_amount: 0,
      remaining_amount: 5212.5,
    })
    expect(wasDeleted('invoice_payments')).toBe(true)
  })

  // Partial reversal (clearing entry with a payment row): only the reversed
  // amount comes off, remaining = total - newPaid, status stays partially_paid.
  it('customer partial reversal keeps remaining_amount = total - newPaid', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: { amount: 500 } }, // invoice_payments select amount
      { data: { paid_amount: 1500, total: 2000, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' }),
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'partially_paid',
      paid_at: null,
      paid_amount: 1000,
      remaining_amount: 1000,
    })
  })

  // The bank line that paid the (now reversed) voucher must be detached so it
  // returns to the inbox and is re-matchable: cleared both by journal_entry_id
  // and by the transaction id captured from the payment row.
  it('releases the linked bank transaction (clears journal_entry_id, invoice_id, category)', async () => {
    const { supabase, tablesUpdated } = createRecordingSupabase([
      { data: null }, // invoice_payments select amount
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } }, // invoices select
      { data: null }, // invoices update
      { data: [{ transaction_id: 'tx-9' }] }, // invoice_payments select transaction_id
      { data: null }, // invoice_payments delete
      { data: null }, // transactions update by journal_entry_id
      { data: null }, // transactions update by id
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' }),
    )

    const txUpdates = tablesUpdated('transactions')
    // Once by journal_entry_id, once by the captured payment transaction_id.
    expect(txUpdates.length).toBe(2)
    const resetPayload = txUpdates[0].ops.find((o) => o.method === 'update')?.args[0]
    expect(resetPayload).toEqual({
      journal_entry_id: null,
      invoice_id: null,
      is_business: null,
      category: null,
    })
    // Second update targets the captured tx id.
    const byId = txUpdates[1].ops.find((o) => o.method === 'in')
    expect(byId?.args).toEqual(['id', ['tx-9']])
  })

})

describe('durable supplier payment reversal', () => {
  const genericEnvelope = {
    valid: true,
    company_id: 'co-1',
    requested_root_count: 1,
    row_count: 3,
    max_depth: 1,
    max_correction_depth: 1,
    terminal_storno_depth: 1,
    rows: [
      {
        root_id: 'root-1',
        parent_id: null,
        edge_kind: 'root',
        id: 'root-1',
        company_id: 'co-1',
        entry_date: '2026-08-01',
        status: 'reversed',
        source_type: 'supplier_invoice_paid',
        correction_of_id: null,
        reverses_id: null,
        reversed_by_id: 'storno-root',
        committed_at: '2026-08-01T10:00:00Z',
        depth: 0,
        path: ['root-1'],
        cycle: false,
      },
      {
        root_id: 'root-1',
        parent_id: 'root-1',
        edge_kind: 'correction',
        id: 'entry-1',
        company_id: 'co-1',
        entry_date: '2026-08-02',
        status: 'posted',
        source_type: 'correction',
        correction_of_id: 'root-1',
        reverses_id: null,
        reversed_by_id: null,
        committed_at: '2026-08-02T10:00:00Z',
        depth: 1,
        path: ['root-1', 'entry-1'],
        cycle: false,
      },
      {
        root_id: 'root-1',
        parent_id: 'root-1',
        edge_kind: 'storno',
        id: 'storno-root',
        company_id: 'co-1',
        entry_date: '2026-08-01',
        status: 'posted',
        source_type: 'storno',
        correction_of_id: null,
        reverses_id: 'root-1',
        reversed_by_id: null,
        committed_at: '2026-08-01T10:01:00Z',
        depth: 1,
        path: ['root-1', 'storno-root'],
        cycle: false,
      },
    ],
  }

  const lineage: SupplierPaymentLineage = {
    company_id: 'co-1',
    requested_journal_entry_id: 'entry-1',
    root_journal_entry_id: 'root-1',
    live_journal_entry_id: 'entry-1',
    allocation_owner_journal_entry_id: 'entry-1',
    is_supplier_payment: true,
    nodes: [
      {
        journal_entry_id: 'root-1',
        parent_journal_entry_id: null,
        relation: 'root',
        depth: 0,
        source_type: 'supplier_invoice_paid',
        has_supplier_payment_allocation: false,
      },
      {
        journal_entry_id: 'entry-1',
        parent_journal_entry_id: 'root-1',
        relation: 'correction',
        depth: 1,
        source_type: 'correction',
        has_supplier_payment_allocation: true,
      },
      {
        journal_entry_id: 'storno-root',
        parent_journal_entry_id: 'root-1',
        relation: 'storno',
        depth: 1,
        source_type: 'storno',
        has_supplier_payment_allocation: false,
      },
    ],
  }

  const outcome: DurableJournalReversalOutcome = {
    status: 'applied',
    company_id: 'co-1',
    root_journal_entry_id: 'root-1',
    original_journal_entry_id: 'entry-1',
    reversal_journal_entry_id: 'storno-1',
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Integration key',
    publications: [
      {
        publication_id: 'publication-committed',
        event_key: 'journal:storno-1:committed',
        event_type: 'journal_entry.committed',
      },
      {
        publication_id: 'publication-reversed',
        event_key: 'journal:entry-1:reversed',
        event_type: 'journal_entry.reversed',
      },
    ],
  }

  it('resolves a correction through the single generic M2 lineage RPC', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'entry-1',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'root-1',
        },
      },
      {
        data: {
          id: 'root-1',
          company_id: 'co-1',
          source_type: 'supplier_invoice_paid',
          correction_of_id: null,
        },
      },
      { data: genericEnvelope },
      { data: [{ id: 'allocation-1', journal_entry_id: 'entry-1' }] },
      { data: [] },
    ])

    const result = await resolveSupplierPaymentLineage(
      supabase as never,
      'co-1',
      'entry-1',
    )

    expect(result).toEqual(lineage)
    expect(supabase.rpc).toHaveBeenCalledWith('get_journal_lineage', {
      p_company_id: 'co-1',
      p_root_ids: ['root-1'],
    })
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'co-1'],
      ['id', 'entry-1'],
      ['company_id', 'co-1'],
      ['id', 'root-1'],
    ])
    expect(findCalls('supplier_invoice_payments', 'eq')).toContainEqual([
      'company_id',
      'co-1',
    ])
    expect(findCalls('supplier_invoice_payment_history', 'eq')).toContainEqual([
      'company_id',
      'co-1',
    ])
  })

  it('keeps a root-owned retained allocation distinct from the requested correction', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'entry-1',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'root-1',
        },
      },
      {
        data: {
          id: 'root-1',
          company_id: 'co-1',
          source_type: 'supplier_invoice_paid',
          correction_of_id: null,
        },
      },
      { data: genericEnvelope },
      { data: [] },
      { data: [{ id: 'allocation-1', journal_entry_id: 'root-1' }] },
    ])

    const result = await resolveSupplierPaymentLineage(
      supabase as never,
      'co-1',
      'entry-1',
    )

    expect(result).toMatchObject({
      root_journal_entry_id: 'root-1',
      requested_journal_entry_id: 'entry-1',
      allocation_owner_journal_entry_id: 'root-1',
    })
    expect(
      result.nodes.find((node) => node.journal_entry_id === 'root-1'),
    ).toMatchObject({ has_supplier_payment_allocation: true })
    expect(
      result.nodes.find((node) => node.journal_entry_id === 'entry-1'),
    ).toMatchObject({ has_supplier_payment_allocation: false })
  })

  it('rejects allocation evidence split across root and requested correction owners', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'entry-1',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'root-1',
        },
      },
      {
        data: {
          id: 'root-1',
          company_id: 'co-1',
          source_type: 'supplier_invoice_paid',
          correction_of_id: null,
        },
      },
      { data: genericEnvelope },
      { data: [{ id: 'active-allocation', journal_entry_id: 'root-1' }] },
      { data: [{ id: 'retained-allocation', journal_entry_id: 'entry-1' }] },
    ])

    await expect(
      resolveSupplierPaymentLineage(supabase as never, 'co-1', 'entry-1'),
    ).rejects.toMatchObject({
      code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
      message: expect.stringContaining('multiple journal entry owners'),
    })
  })

  it('rejects an allocation owned by an arbitrary earlier correction', async () => {
    const correction = genericEnvelope.rows[1]!
    const rootStorno = genericEnvelope.rows[2]!
    const deeperEnvelope = {
      ...genericEnvelope,
      row_count: 5,
      max_depth: 2,
      max_correction_depth: 2,
      terminal_storno_depth: 2,
      rows: [
        genericEnvelope.rows[0]!,
        {
          ...correction,
          status: 'reversed',
          reversed_by_id: 'storno-entry-1',
        },
        rootStorno,
        {
          ...correction,
          parent_id: 'entry-1',
          id: 'entry-2',
          correction_of_id: 'entry-1',
          depth: 2,
          path: ['root-1', 'entry-1', 'entry-2'],
        },
        {
          ...rootStorno,
          parent_id: 'entry-1',
          id: 'storno-entry-1',
          reverses_id: 'entry-1',
          depth: 2,
          path: ['root-1', 'entry-1', 'storno-entry-1'],
        },
      ],
    }
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'entry-2',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'entry-1',
        },
      },
      {
        data: {
          id: 'entry-1',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'root-1',
        },
      },
      {
        data: {
          id: 'root-1',
          company_id: 'co-1',
          source_type: 'supplier_invoice_paid',
          correction_of_id: null,
        },
      },
      { data: deeperEnvelope },
      { data: [{ id: 'allocation-1', journal_entry_id: 'entry-1' }] },
      { data: [] },
    ])

    await expect(
      resolveSupplierPaymentLineage(supabase as never, 'co-1', 'entry-2'),
    ).rejects.toMatchObject({
      code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
      message: expect.stringContaining(
        'neither the lineage root nor the requested correction',
      ),
    })
  })

  it('rejects a contradictory generic M2 envelope before allocation reads', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'entry-1',
          company_id: 'co-1',
          source_type: 'correction',
          correction_of_id: 'root-1',
        },
      },
      {
        data: {
          id: 'root-1',
          company_id: 'co-1',
          source_type: 'supplier_invoice_paid',
          correction_of_id: null,
        },
      },
      { data: { ...genericEnvelope, row_count: 2 } },
    ])

    await expect(
      resolveSupplierPaymentLineage(supabase as never, 'co-1', 'entry-1'),
    ).rejects.toMatchObject({
      code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
      message: expect.stringContaining('generic lineage RPC'),
    })
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })

  it('passes exact actor and reversal arguments to the M3 command', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: outcome, error: null })
    const result = await applySupplierPaymentReversal(
      { rpc } as never,
      {
        companyId: 'co-1',
        requestedJournalEntryId: 'entry-1',
        reversalDate: '2026-08-15',
        actor: {
          actor_type: 'api_key',
          actor_id: 'key-1',
          actor_label: 'Integration key',
        },
        lineage,
      },
    )

    expect(result).toEqual(outcome)
    expect(rpc).toHaveBeenCalledWith('apply_supplier_payment_reversal', {
      p_company_id: 'co-1',
      p_root_journal_entry_id: 'root-1',
      p_original_journal_entry_id: 'entry-1',
      p_reversal_date: '2026-08-15',
      p_actor_type: 'api_key',
      p_actor_id: 'key-1',
      p_actor_label: 'Integration key',
    })
  })

  it.each([
    [
      'wrong company',
      { ...lineage, company_id: 'co-2' },
    ],
    [
      'wrong requested identity',
      { ...lineage, requested_journal_entry_id: 'entry-2' },
    ],
    [
      'wrong live identity',
      { ...lineage, live_journal_entry_id: 'entry-2' },
    ],
    [
      'empty root identity',
      { ...lineage, root_journal_entry_id: '' },
    ],
    [
      'wrong root identity',
      { ...lineage, root_journal_entry_id: 'root-2' },
    ],
    [
      'node set without the root identity',
      {
        ...lineage,
        nodes: lineage.nodes.filter(
          (node) => node.journal_entry_id !== lineage.root_journal_entry_id,
        ),
      },
    ],
    [
      'node set without the requested identity',
      {
        ...lineage,
        nodes: lineage.nodes.filter(
          (node) => node.journal_entry_id !== lineage.requested_journal_entry_id,
        ),
      },
    ],
  ] satisfies Array<[string, SupplierPaymentLineage]>)(
    'rejects %s lineage before the M3 RPC',
    async (_caseName, contradictoryLineage) => {
      const rpc = vi.fn()

      await expect(
        applySupplierPaymentReversal(
          { rpc } as never,
          {
            companyId: 'co-1',
            requestedJournalEntryId: 'entry-1',
            reversalDate: '2026-08-15',
            actor: {
              actor_type: 'api_key',
              actor_id: 'key-1',
              actor_label: 'Integration key',
            },
            lineage: contradictoryLineage,
          },
        ),
      ).rejects.toMatchObject({
        code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
        operation: 'apply_supplier_payment_reversal',
        recovery: {
          company_id: 'co-1',
          original_journal_entry_id: 'entry-1',
          reversal_journal_entry_id: null,
          publication_ids: [],
        },
      } satisfies Partial<DurableAccountingIdentityError>)
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it('retries through the recorded storno and returns the stored identities', async () => {
    const storedOutcome = {
      ...outcome,
      status: 'already_applied' as const,
      actor_type: 'user' as const,
      actor_id: 'original-user',
      actor_label: null,
    }
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'connection lost after commit' },
      })
      .mockResolvedValueOnce({ data: storedOutcome, error: null })

    const result = await applySupplierPaymentReversal(
      { rpc } as never,
      {
        companyId: 'co-1',
        requestedJournalEntryId: 'entry-1',
        reversalDate: '2026-08-15',
        actor: {
          actor_type: 'api_key',
          actor_id: 'retrying-key',
          actor_label: 'Retrying key',
        },
        lineage,
      },
    )

    expect(rpc).toHaveBeenCalledTimes(2)
    const expectedArgs = {
      p_company_id: 'co-1',
      p_root_journal_entry_id: 'root-1',
      p_original_journal_entry_id: 'entry-1',
      p_reversal_date: '2026-08-15',
      p_actor_type: 'api_key',
      p_actor_id: 'retrying-key',
      p_actor_label: 'Retrying key',
    }
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      'apply_supplier_payment_reversal',
      expectedArgs,
    )
    expect(rpc).toHaveBeenNthCalledWith(
      2,
      'apply_supplier_payment_reversal',
      expectedArgs,
    )
    expect(rpc.mock.calls[1]![1]).toBe(rpc.mock.calls[0]![1])
    expect(result).toEqual(storedOutcome)
  })

  it('returns a stable conflict with the recorded storno identity', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        status: 'conflict',
        reversal_journal_entry_id: 'different-storno',
        reason: 'requested root differs from retained allocation root',
      },
      error: null,
    })

    await expect(
      applySupplierPaymentReversal(
        { rpc } as never,
        {
          companyId: 'co-1',
          requestedJournalEntryId: 'entry-1',
          reversalDate: '2026-08-15',
          actor: {
            actor_type: 'api_key',
            actor_id: 'key-1',
            actor_label: 'Integration key',
          },
          lineage,
        },
      ),
    ).rejects.toMatchObject({
      code: 'DURABLE_ACCOUNTING_CONFLICT',
      reason: 'requested root differs from retained allocation root',
      recovery: {
        company_id: 'co-1',
        original_journal_entry_id: 'entry-1',
        reversal_journal_entry_id: 'different-storno',
        publication_ids: [],
      },
    })
  })

  it('fails closed with every recoverable identity on malformed publication', async () => {
    const malformed = {
      ...outcome,
      publications: [outcome.publications[0], outcome.publications[0]],
    }
    const rpc = vi.fn().mockResolvedValue({ data: malformed, error: null })

    await expect(
      applySupplierPaymentReversal(
        { rpc } as never,
        {
          companyId: 'co-1',
          requestedJournalEntryId: 'entry-1',
          reversalDate: '2026-08-15',
          actor: {
            actor_type: 'api_key',
            actor_id: 'key-1',
            actor_label: 'Integration key',
          },
          lineage,
        },
      ),
    ).rejects.toMatchObject({
      code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
      recovery: {
        company_id: 'co-1',
        original_journal_entry_id: 'entry-1',
        reversal_journal_entry_id: 'storno-1',
        publication_ids: [
          'publication-committed',
          'publication-committed',
        ],
      },
    } satisfies Partial<DurableAccountingIdentityError>)
  })

  it('forbids the former supplier table-write fallback', async () => {
    const from = vi.fn()
    await expect(
      syncInvoiceStatusFromPaymentEntry(
        { from } as never,
        'co-1',
        {
          id: 'entry-1',
          source_type: 'supplier_invoice_paid',
          source_id: 'supplier-invoice-1',
        },
      ),
    ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(from).not.toHaveBeenCalled()
  })
})
