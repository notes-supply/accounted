import { describe, expect, it, vi } from 'vitest'
import { fetchPaymentsAsOf } from '../reskontra-payments'

type Row = Record<string, unknown>

function makeSupabase(paymentRows: Row[], journalRows: Row[] = []) {
  const calls: Array<{
    table: string
    select?: string
    filters: Array<{ method: string; args: unknown[] }>
    order?: unknown[]
    range?: unknown[]
  }> = []

  const supabase = {
    from: vi.fn((table: string) => {
      const call = { table, filters: [] } as (typeof calls)[number]
      calls.push(call)
      const builder = {
        select: vi.fn((columns: string) => {
          call.select = columns
          return builder
        }),
        eq: vi.fn((...args: unknown[]) => {
          call.filters.push({ method: 'eq', args })
          return builder
        }),
        in: vi.fn((...args: unknown[]) => {
          call.filters.push({ method: 'in', args })
          return builder
        }),
        order: vi.fn((...args: unknown[]) => {
          call.order = args
          return builder
        }),
        range: vi.fn((...args: unknown[]) => {
          call.range = args
          return Promise.resolve({
            data: table === 'journal_entries' ? journalRows : paymentRows,
            error: null,
          })
        }),
      }
      return builder
    }),
  }
  return { supabase, calls }
}

const activePayment = {
  id: 'payment-1',
  supplier_invoice_id: 'supplier-invoice-1',
  amount: 500,
  payment_date: '2025-12-15',
  journal_entry_id: 'payment-entry-1',
  reversed_at: null,
  reversed_by_journal_entry_id: null,
}

describe('fetchPaymentsAsOf', () => {
  it('counts an active supplier allocation paid by the cutoff', async () => {
    const { supabase, calls } = makeSupabase([activePayment])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      table: 'supplier_invoice_payments',
      order: ['id', { ascending: true }],
      range: [0, 999],
    })
  })

  it('counts a supplier allocation when its exact storno is after the cutoff', async () => {
    const { supabase } = makeSupabase(
      [{
        ...activePayment,
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: 'storno-1',
      }],
      [{
        id: 'storno-1',
        entry_date: '2026-01-05',
        status: 'posted',
        source_type: 'storno',
        reverses_id: 'payment-entry-1',
      }],
    )

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
  })

  it('keeps evidence but excludes payment when the exact storno is on the cutoff', async () => {
    const { supabase } = makeSupabase(
      [{
        ...activePayment,
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: 'storno-1',
      }],
      [{
        id: 'storno-1',
        entry_date: '2025-12-31',
        status: 'posted',
        source_type: 'storno',
        reverses_id: 'payment-entry-1',
      }],
    )

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.has('supplier-invoice-1')).toBe(false)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
  })

  it('fails loudly when reversal journal lineage is missing', async () => {
    const { supabase } = makeSupabase([{
      ...activePayment,
      reversed_at: '2026-01-10T12:00:00Z',
      reversed_by_journal_entry_id: 'missing-storno',
    }])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Could not resolve 1 supplier payment reversal journal entries/)
  })

  it('fails loudly when reversal journal lineage is malformed', async () => {
    const { supabase } = makeSupabase(
      [{
        ...activePayment,
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: 'storno-1',
      }],
      [{
        id: 'storno-1',
        entry_date: '2026-01-05',
        status: 'posted',
        source_type: 'storno',
        reverses_id: 'different-payment-entry',
      }],
    )

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Malformed supplier payment reversal lineage/)
  })

  it('leaves customer payment history unchanged and does not fetch journal lineage', async () => {
    const { supabase, calls } = makeSupabase([{
      id: 'customer-payment-1',
      invoice_id: 'invoice-1',
      amount: 125,
      payment_date: '2025-12-15',
    }])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'invoice_payments',
      'invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('invoice-1')).toBe(125)
    expect(result.hasRows).toEqual(new Set(['invoice-1']))
    expect(calls).toHaveLength(1)
    expect(calls[0].select).toBe('invoice_id, id, amount, payment_date')
  })
})
