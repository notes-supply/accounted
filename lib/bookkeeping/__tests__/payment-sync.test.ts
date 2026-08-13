import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isPaymentSourceType, syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { JournalEntry } from '@/types'

/**
 * A Supabase mock that records the table + method + args of chained customer
 * payment calls. Supplier reversals deliberately cross one RPC boundary.
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
  const eventPublication = {
    status: 'published',
    event_outbox_ids: ['event-committed', 'event-reversed'],
    event_log_count: 2,
    webhook_delivery_count: 0,
  }


  it('is a no-op when source_type is not a payment', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'manual' as JournalEntry['source_type'] }),
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('applies a supplier reversal through one atomic RPC boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        status: 'applied',
        allocation_count: 1,
        invoice_count: 1,
        transaction_count: 1,
        event_publication: eventPublication,
      },
      error: null,
    })

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry(),
      'storno-1',
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('apply_supplier_payment_reversal', {
      p_company_id: 'co-1',
      p_original_journal_entry_id: 'entry-1',
      p_storno_journal_entry_id: 'storno-1',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('uses the same atomic RPC for a source-less batch voucher', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        status: 'applied',
        allocation_count: 2,
        invoice_count: 2,
        transaction_count: 1,
        event_publication: eventPublication,
      },
      error: null,
    })

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_id: null }),
      'storno-batch',
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('apply_supplier_payment_reversal', {
      p_company_id: 'co-1',
      p_original_journal_entry_id: 'entry-1',
      p_storno_journal_entry_id: 'storno-batch',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('routes allocation-backed manual semantics through the supplier RPC', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        status: 'already_applied',
        allocation_count: 1,
        invoice_count: 1,
        transaction_count: 0,
        event_publication: {
          ...eventPublication,
          status: 'already_published',
        },
      },
      error: null,
    })

    await expect(syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'manual' }),
      'storno-manual',
      true,
    )).resolves.toBe('already_published')

    expect(supabase.rpc).toHaveBeenCalledWith('apply_supplier_payment_reversal', {
      p_company_id: 'co-1',
      p_original_journal_entry_id: 'entry-1',
      p_storno_journal_entry_id: 'storno-manual',
    })
  })

  it('fails before the RPC when a supplier reversal lacks a storno id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry()),
    ).rejects.toThrow(/missing its storno journal entry id/)

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('surfaces an atomic supplier reversal database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: null,
      error: { code: '55000', message: 'supplier payment reversal invoice state conflict' },
    })

    await expect(
      syncInvoiceStatusFromPaymentEntry(
        supabase as never,
        'co-1',
        entry(),
        'storno-1',
      ),
    ).rejects.toThrow(
      /Failed to restore supplier payment state: supplier payment reversal invoice state conflict/,
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a malformed success response from the supplier reversal RPC', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'applied' }, error: null })

    await expect(
      syncInvoiceStatusFromPaymentEntry(
        supabase as never,
        'co-1',
        entry(),
        'storno-1',
      ),
    ).rejects.toThrow(/returned an invalid result/)

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('keeps legacy cash compatibility inside the same atomic RPC', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: true,
        status: 'applied_legacy',
        allocation_count: 0,
        invoice_count: 1,
        transaction_count: 1,
        event_publication: eventPublication,
      },
      error: null,
    })

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'supplier_invoice_cash_payment' }),
      'storno-cash',
    )

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('keeps the existing customer partial-payment cleanup behavior', async () => {
    const { supabase, updatePayload, wasDeleted } = createRecordingSupabase([
      { data: { amount: 500 } },
      { data: { paid_amount: 1500, total: 2000, due_date: '2099-12-31' } },
      { data: null },
      { data: [] },
      { data: null },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' }),
      'storno-customer',
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'partially_paid',
      paid_at: null,
      paid_amount: 1000,
      remaining_amount: 1000,
    })
    expect(wasDeleted('invoice_payments')).toBe(true)
  })

  it('resets a customer cash payment with no payment row', async () => {
    const { supabase, updatePayload } = createRecordingSupabase([
      { data: null },
      { data: { paid_amount: 5212.5, total: 5212.5, due_date: '2099-12-31' } },
      { data: null },
      { data: [] },
      { data: null },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' }),
      'storno-customer-cash',
    )

    expect(updatePayload('invoices')).toEqual({
      status: 'sent',
      paid_at: null,
      paid_amount: 0,
      remaining_amount: 5212.5,
    })
  })
})
