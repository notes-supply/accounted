import { describe, expect, it, vi } from 'vitest'
import { fetchPaymentsAsOf } from '../reskontra-payments'

describe('fetchPaymentsAsOf', () => {
  it('excludes soft-reversed supplier allocations from current report history', async () => {
    const filters: Array<{ method: string; args: unknown[] }> = []
    const builder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation((...args: unknown[]) => {
        filters.push({ method: 'eq', args })
        return builder
      }),
      is: vi.fn().mockImplementation((...args: unknown[]) => {
        filters.push({ method: 'is', args })
        return builder
      }),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockResolvedValue({
        data: [{
          id: 'payment-1',
          supplier_invoice_id: 'supplier-invoice-1',
          amount: 500,
          payment_date: '2025-12-15',
        }],
        error: null,
      }),
    }
    const supabase = { from: vi.fn().mockReturnValue(builder) }

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
    expect(filters).toContainEqual({ method: 'is', args: ['reversed_at', null] })
  })
})
