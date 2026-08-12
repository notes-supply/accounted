import { describe, expect, it, vi } from 'vitest'
import { fetchPeriodLinkedRows } from '../period-linked-rows'

function makeSupabase() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let table = ''

  function builder() {
    const b = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ method: 'eq', args })
        return b
      }),
      in: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ method: 'in', args })
        return b
      }),
      not: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ method: 'not', args })
        return b
      }),
      lte: vi.fn().mockImplementation((...args: unknown[]) => {
        calls.push({ method: 'lte', args })
        return b
      }),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockImplementation((from: number) => {
        if (table === 'invoices') {
          return Promise.resolve({
            data: from === 0
              ? [
                  { id: 'inv-1', journal_entry_id: 'je-1' },
                  { id: 'inv-late', journal_entry_id: 'je-late' },
                ]
              : [],
            error: null,
          })
        }
        return Promise.resolve({ data: [{ id: 'je-1' }], error: null })
      }),
    }
    return b
  }

  return {
    supabase: {
      from: vi.fn().mockImplementation((nextTable: string) => {
        table = nextTable
        return builder()
      }),
    },
    calls,
  }
}

describe('fetchPeriodLinkedRows', () => {
  it('binds invoice selection to registrations posted by the period end', async () => {
    const { supabase, calls } = makeSupabase()

    const rows = await fetchPeriodLinkedRows<{ id: string }>({
      supabase: supabase as never,
      table: 'invoices',
      select: 'id',
      entryLinkColumn: 'journal_entry_id',
      companyId: 'co-1',
      throughDate: '2025-12-31',
    })

    expect(rows).toEqual([{ id: 'inv-1', journal_entry_id: 'je-1' }])
    expect(calls.filter((call) => call.method === 'lte')).toEqual([
      { method: 'lte', args: ['invoice_date', '2025-12-31'] },
      { method: 'lte', args: ['entry_date', '2025-12-31'] },
    ])
    expect(calls).toContainEqual({ method: 'not', args: ['journal_entry_id', 'is', null] })
    expect(calls).toContainEqual({ method: 'in', args: ['status', ['posted', 'reversed']] })
    expect(calls).toContainEqual({
      method: 'in',
      args: ['id', ['je-1', 'je-late']],
    })
  })
})
