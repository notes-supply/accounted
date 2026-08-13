import { describe, expect, it, vi } from 'vitest'
import { fetchPaymentTotalsByParent } from '../payment-totals'

type Row = Record<string, unknown>
type FilterCall = {
  method: 'eq' | 'in' | 'lte'
  args: unknown[]
}
type QueryCall = {
  table: string
  select?: string
  filters: FilterCall[]
  order?: unknown[]
  range?: [number, number]
}
type RpcCall = {
  name: string
  params: { p_company_id: string; p_root_ids: string[] }
}

function lineagePayload(journalRows: Row[], companyId: string, rootIds: string[]) {
  const entries = new Map(journalRows.map((row) => [row.id as string, row]))
  const children = new Map<string, Row[]>()
  for (const row of journalRows) {
    for (const parentId of [row.correction_of_id, row.reverses_id]) {
      if (typeof parentId !== 'string') continue
      const siblings = children.get(parentId) ?? []
      if (!siblings.includes(row)) siblings.push(row)
      children.set(parentId, siblings)
    }
  }

  const rows: Row[] = []
  const visit = (
    rootId: string,
    entry: Row,
    parentId: string | null,
    edgeKind: 'root' | 'correction' | 'storno',
    path: string[],
  ) => {
    const id = entry.id as string
    const cycle = path.includes(id)
    const nextPath = [...path, id]
    rows.push({
      root_id: rootId,
      parent_id: parentId,
      edge_kind: edgeKind,
      id,
      entry_date: entry.entry_date,
      status: entry.status,
      source_type: entry.source_type,
      correction_of_id: entry.correction_of_id,
      reverses_id: entry.reverses_id,
      committed_at: entry.committed_at,
      depth: nextPath.length - 1,
      path: nextPath,
      cycle,
    })
    if (cycle || edgeKind === 'storno') return
    for (const child of children.get(id) ?? []) {
      visit(
        rootId,
        child,
        id,
        child.correction_of_id === id ? 'correction' : 'storno',
        nextPath,
      )
    }
  }

  const uniqueRootIds = Array.from(new Set(rootIds))
  for (const rootId of uniqueRootIds) {
    const root = entries.get(rootId)
    if (root?.company_id === companyId) visit(rootId, root, null, 'root', [])
  }
  return { requested_root_count: uniqueRootIds.length, rows }
}

function makeSupabase(
  paymentRows: Row[],
  journalRows: Row[] = [],
  errors: { query?: string; rpc?: string } = {},
) {
  const queryCalls: QueryCall[] = []
  const rpcCalls: RpcCall[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      const call: QueryCall = { table, filters: [] }
      queryCalls.push(call)
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
        lte: vi.fn((...args: unknown[]) => {
          call.filters.push({ method: 'lte', args })
          return builder
        }),
        order: vi.fn((...args: unknown[]) => {
          call.order = args
          return builder
        }),
        range: vi.fn((from: number, to: number) => {
          call.range = [from, to]
          if (errors.query) {
            return Promise.resolve({ data: null, error: { message: errors.query } })
          }
          const filteredRows = paymentRows.filter((row) =>
            call.filters.every(({ method, args }) => {
              const [column, value] = args as [string, unknown]
              if (method === 'eq') return row[column] === value
              if (method === 'in') return (value as unknown[]).includes(row[column])
              return String(row[column]) <= String(value)
            }),
          )
          return Promise.resolve({
            data: filteredRows.slice(from, to + 1),
            error: null,
          })
        }),
      }
      return builder
    }),
    rpc: vi.fn(async (
      name: string,
      params: { p_company_id: string; p_root_ids: string[] },
    ) => {
      rpcCalls.push({ name, params })
      if (errors.rpc) {
        return { data: null, error: { message: errors.rpc } }
      }
      return {
        data: lineagePayload(journalRows, params.p_company_id, params.p_root_ids),
        error: null,
      }
    }),
  }
  return { supabase, queryCalls, rpcCalls }
}

function supplierPayment(over: Row = {}): Row {
  return {
    id: 'payment-1',
    company_id: 'co-1',
    supplier_invoice_id: 'supplier-invoice-1',
    amount: 500,
    payment_date: '2025-12-15',
    journal_entry_id: 'payment-entry-1',
    reversed_at: null,
    reversed_by_journal_entry_id: null,
    ...over,
  }
}

function journalEntry(id: string, over: Row = {}): Row {
  return {
    id,
    company_id: 'co-1',
    entry_date: '2025-12-15',
    status: 'posted',
    source_type: 'supplier_invoice_paid',
    correction_of_id: null,
    reverses_id: null,
    committed_at: null,
    ...over,
  }
}

function stornoEntry(parentId: string, entryDate: string, over: Row = {}): Row {
  return journalEntry(`storno-${parentId}`, {
    entry_date: entryDate,
    source_type: 'storno',
    reverses_id: parentId,
    ...over,
  })
}

function correctionEntry(parentId: string, entryDate: string, over: Row = {}): Row {
  return journalEntry(`correction-${parentId}`, {
    entry_date: entryDate,
    source_type: 'correction',
    correction_of_id: parentId,
    ...over,
  })
}

async function supplierTotals(
  supabase: unknown,
  parentIds = ['supplier-invoice-1'],
) {
  return fetchPaymentTotalsByParent({
    supabase: supabase as never,
    table: 'supplier_invoice_payments',
    parentColumn: 'supplier_invoice_id',
    companyId: 'co-1',
    parentIds,
    throughDate: '2025-12-31',
  })
}

describe('fetchPaymentTotalsByParent', () => {
  it('keeps customer payment queries date-bounded, chunked, and paginated', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `inv-${index}`)
    const page = Array.from({ length: 1001 }, (_, index) => ({
      id: `p-${index}`,
      company_id: 'co-1',
      invoice_id: 'inv-0',
      payment_date: '2025-12-31',
      amount: 1,
    }))
    const { supabase, queryCalls, rpcCalls } = makeSupabase([
      ...page,
      {
        id: 'last',
        company_id: 'co-1',
        invoice_id: 'inv-500',
        payment_date: '2025-12-31',
        amount: 7,
      },
      {
        id: 'future',
        company_id: 'co-1',
        invoice_id: 'inv-500',
        payment_date: '2026-01-01',
        amount: 100,
      },
    ])

    const totals = await fetchPaymentTotalsByParent({
      supabase: supabase as never,
      table: 'invoice_payments',
      parentColumn: 'invoice_id',
      companyId: 'co-1',
      parentIds: ids,
      throughDate: '2025-12-31',
    })

    expect(totals.get('inv-0')).toBe(1001)
    expect(totals.get('inv-500')).toBe(7)
    expect(queryCalls.map((call) => call.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [0, 999],
    ])
    expect(queryCalls.map((call) =>
      (call.filters.find((filter) => filter.method === 'in')?.args[1] as string[]).length,
    )).toEqual([500, 500, 1])
    expect(queryCalls.every((call) => call.filters.some(({ method, args }) =>
      method === 'eq' && args[0] === 'company_id' && args[1] === 'co-1'
    ))).toBe(true)
    expect(queryCalls.every((call) => call.filters.some(({ method, args }) =>
      method === 'lte' && args[0] === 'payment_date' && args[1] === '2025-12-31'
    ))).toBe(true)
    expect(rpcCalls).toEqual([])
  })

  it('uses the active supplier voucher date and preserves invoice currency units', async () => {
    const root = journalEntry('payment-entry-1', { entry_date: '2025-12-20' })
    const { supabase, queryCalls, rpcCalls } = makeSupabase([
      supplierPayment({ payment_date: '2026-01-10', amount: 123.45 }),
      supplierPayment({
        id: 'foreign-company-payment',
        company_id: 'co-2',
        amount: 999,
      }),
    ], [root])

    const totals = await supplierTotals(supabase)

    expect(totals.get('supplier-invoice-1')).toBe(123.45)
    expect(queryCalls[0]).toMatchObject({
      table: 'supplier_invoice_payments',
      select: 'id, supplier_invoice_id, amount, payment_date, journal_entry_id',
      order: ['id', { ascending: true }],
      range: [0, 999],
    })
    expect(queryCalls[0].filters.some((filter) => filter.method === 'lte')).toBe(false)
    expect(queryCalls[0].filters).toContainEqual({
      method: 'eq',
      args: ['company_id', 'co-1'],
    })
    expect(rpcCalls).toEqual([{
      name: 'get_supplier_payment_lineage',
      params: { p_company_id: 'co-1', p_root_ids: ['payment-entry-1'] },
    }])
  })

  it.each([
    { label: 'before', stornoDate: '2025-12-20' },
    { label: 'on', stornoDate: '2025-12-31' },
  ])('excludes a supplier payment reversed $label the cutoff', async ({ stornoDate }) => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const storno = stornoEntry(root.id as string, stornoDate, { id: 'storno-1' })
    const { supabase } = makeSupabase([
      supplierPayment({
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: storno.id,
      }),
    ], [root, storno])

    const totals = await supplierTotals(supabase)

    expect(totals.has('supplier-invoice-1')).toBe(false)
  })

  it('includes a supplier payment reversed after the cutoff', async () => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const storno = stornoEntry(root.id as string, '2026-01-05', { id: 'storno-1' })
    const { supabase } = makeSupabase([
      supplierPayment({
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: storno.id,
      }),
    ], [root, storno])

    const totals = await supplierTotals(supabase)

    expect(totals.get('supplier-invoice-1')).toBe(500)
  })

  it.each([
    {
      label: 'before the cutoff',
      rootDate: '2026-01-15',
      correctionDate: '2025-12-20',
      expected: 500,
    },
    {
      label: 'after the cutoff',
      rootDate: '2025-12-15',
      correctionDate: '2026-01-15',
      expected: undefined,
    },
  ])('uses a correction effective $label', async ({
    rootDate,
    correctionDate,
    expected,
  }) => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      entry_date: rootDate,
    })
    const storno = stornoEntry(root.id as string, rootDate)
    const correction = correctionEntry(root.id as string, correctionDate)
    const { supabase } = makeSupabase([
      supplierPayment({ payment_date: rootDate }),
    ], [root, storno, correction])

    const totals = await supplierTotals(supabase)

    expect(totals.get('supplier-invoice-1')).toBe(expected)
  })

  it('keeps payment_date behavior for legacy null journal links', async () => {
    const { supabase, rpcCalls } = makeSupabase([
      supplierPayment({
        id: 'legacy-before',
        journal_entry_id: null,
        payment_date: '2025-12-31',
        amount: 200,
      }),
      supplierPayment({
        id: 'legacy-after',
        journal_entry_id: null,
        payment_date: '2026-01-01',
        amount: 300,
      }),
    ])

    const totals = await supplierTotals(supabase)

    expect(totals.get('supplier-invoice-1')).toBe(200)
    expect(rpcCalls).toEqual([])
  })

  it('paginates supplier rows and batches lineage roots within bounded queries', async () => {
    const rootCount = 301
    const paymentCount = 1001
    const parentIds = Array.from({ length: rootCount }, (_, index) => `supplier-${index}`)
    const paymentRows = Array.from({ length: paymentCount }, (_, index) => {
      const rootIndex = index % rootCount
      return supplierPayment({
        id: `payment-${index}`,
        supplier_invoice_id: parentIds[rootIndex],
        journal_entry_id: `entry-${rootIndex}`,
        amount: 1,
      })
    })
    const journalRows = parentIds.map((_, index) => journalEntry(`entry-${index}`))
    const { supabase, queryCalls, rpcCalls } = makeSupabase(paymentRows, journalRows)

    const totals = await supplierTotals(supabase, parentIds)

    expect(totals.size).toBe(rootCount)
    expect(Array.from(totals.values()).reduce((sum, amount) => sum + amount, 0))
      .toBe(paymentCount)
    expect(queryCalls.map((call) => call.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(queryCalls.every((call) =>
      (call.filters.find((filter) => filter.method === 'in')?.args[1] as string[])
        .length === rootCount
    )).toBe(true)
    expect(rpcCalls.map((call) => call.params.p_root_ids.length)).toEqual([300, 1])
    expect(rpcCalls.every((call) =>
      call.name === 'get_supplier_payment_lineage'
      && call.params.p_company_id === 'co-1'
    )).toBe(true)
  })

  it('throws instead of converting a supplier payment query error into an empty total', async () => {
    const { supabase } = makeSupabase([], [], { query: 'payment query failed' })

    await expect(supplierTotals(supabase)).rejects.toThrow('payment query failed')
  })

  it('throws instead of converting a lineage RPC error into an empty total', async () => {
    const { supabase } = makeSupabase(
      [supplierPayment()],
      [journalEntry('payment-entry-1')],
      { rpc: 'lineage query failed' },
    )

    await expect(supplierTotals(supabase)).rejects.toThrow(
      'Could not fetch supplier payment journal lineage: lineage query failed',
    )
  })
})
