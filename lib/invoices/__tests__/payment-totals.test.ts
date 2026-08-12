import { describe, expect, it, vi } from 'vitest'
import { fetchPaymentTotalsByParent } from '../payment-totals'

interface PaymentRow {
  id: string
  invoice_id: string
  amount: number
}

function makeSupabase(
  resultFor: (ids: string[], from: number, to: number) => {
    data: PaymentRow[] | null
    error: { message: string } | null
  },
) {
  const filters: Array<{ method: string; args: unknown[] }> = []
  let currentIds: string[] = []

  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation((...args: unknown[]) => {
      filters.push({ method: 'eq', args })
      return builder
    }),
    lte: vi.fn().mockImplementation((...args: unknown[]) => {
      filters.push({ method: 'lte', args })
      return builder
    }),
    in: vi.fn().mockImplementation((...args: unknown[]) => {
      filters.push({ method: 'in', args })
      currentIds = args[1] as string[]
      return builder
    }),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockImplementation((from: number, to: number) =>
      Promise.resolve(resultFor(currentIds, from, to))),
  }

  return {
    supabase: { from: vi.fn().mockReturnValue(builder) },
    builder,
    filters,
  }
}

describe('fetchPaymentTotalsByParent', () => {
  it('chunks parent ids, paginates each chunk, and sums payment amounts', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `inv-${index}`)
    const page = Array.from({ length: 1000 }, (_, index) => ({
      id: `p-${index}`,
      invoice_id: 'inv-0',
      amount: 1,
    }))
    const { supabase, builder, filters } = makeSupabase((chunk, from) => {
      if (chunk[0] === 'inv-0') {
        return from === 0
          ? { data: page, error: null }
          : { data: [{ id: 'p-1000', invoice_id: 'inv-0', amount: 2 }], error: null }
      }
      return { data: [{ id: 'last', invoice_id: 'inv-500', amount: 7 }], error: null }
    })

    const totals = await fetchPaymentTotalsByParent({
      supabase: supabase as never,
      table: 'invoice_payments',
      parentColumn: 'invoice_id',
      companyId: 'co-1',
      parentIds: ids,
      throughDate: '2025-12-31',
    })

    expect(totals.get('inv-0')).toBe(1002)
    expect(totals.get('inv-500')).toBe(7)
    expect(builder.range).toHaveBeenCalledWith(0, 999)
    expect(builder.range).toHaveBeenCalledWith(1000, 1999)
    expect(filters.filter((filter) => filter.method === 'in').map((filter) =>
      (filter.args[1] as string[]).length)).toEqual([500, 500, 1])
    expect(filters).toContainEqual({ method: 'eq', args: ['company_id', 'co-1'] })
    expect(filters).toContainEqual({ method: 'lte', args: ['payment_date', '2025-12-31'] })
  })

  it('throws instead of converting a database error into an empty total', async () => {
    const { supabase } = makeSupabase(() => ({
      data: null,
      error: { message: 'payment query failed' },
    }))

    await expect(fetchPaymentTotalsByParent({
      supabase: supabase as never,
      table: 'invoice_payments',
      parentColumn: 'invoice_id',
      companyId: 'co-1',
      parentIds: ['inv-1'],
      throughDate: '2025-12-31',
    })).rejects.toThrow('payment query failed')
  })
})
