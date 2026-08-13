import { describe, expect, it, vi } from 'vitest'
import { fetchPaymentsAsOf } from '../reskontra-payments'

type Row = Record<string, unknown>
type QueryCall = {
  table: string
  select?: string
  filters: Array<{ method: 'eq' | 'in'; args: unknown[] }>
  order?: unknown[]
  range?: unknown[]
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

function makeSupabase(paymentRows: Row[], journalRows: Row[] = []) {
  const calls: QueryCall[] = []
  const rpcCalls: RpcCall[] = []
  const supabase = {
    from: vi.fn((table: string) => {
      const call: QueryCall = { table, filters: [] }
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
        range: vi.fn((from: number, to: number) => {
          call.range = [from, to]
          const filteredRows = paymentRows.filter((row) =>
            call.filters.every(({ method, args }) => {
              const [column, value] = args as [string, unknown]
              return method === 'eq'
                ? row[column] === value
                : (value as unknown[]).includes(row[column])
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
      return {
        data: lineagePayload(journalRows, params.p_company_id, params.p_root_ids),
        error: null,
      }
    }),
  }
  return { supabase, calls, rpcCalls }
}

const activePayment = {
  id: 'payment-1',
  company_id: 'co-1',
  supplier_invoice_id: 'supplier-invoice-1',
  amount: 500,
  payment_date: '2025-12-15',
  journal_entry_id: 'payment-entry-1',
  reversed_at: null,
  reversed_by_journal_entry_id: null,
}

function journalEntry(id: string, over: Row = {}) {
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

function correctionEntry(parentId: string, entryDate: string, over: Row = {}) {
  return journalEntry(`correction-${parentId}-${entryDate}`, {
    entry_date: entryDate,
    source_type: 'correction',
    correction_of_id: parentId,
    ...over,
  })
}

function stornoEntry(parentId: string, entryDate: string, over: Row = {}) {
  return journalEntry(`storno-${parentId}-${entryDate}`, {
    entry_date: entryDate,
    source_type: 'storno',
    reverses_id: parentId,
    ...over,
  })
}

describe('fetchPaymentsAsOf', () => {
  it('uses the linked voucher date for an active supplier allocation', async () => {
    const root = journalEntry('payment-entry-1')
    const { supabase, calls } = makeSupabase([activePayment], [
      root,
      journalEntry('wrong-company-copy', { company_id: 'co-2' }),
    ])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
    expect(calls[0]).toMatchObject({
      table: 'supplier_invoice_payments',
      order: ['id', { ascending: true }],
      range: [0, 999],
    })
    expect(calls.every((call) =>
      call.filters.some(({ method, args }) =>
        method === 'eq' && args[0] === 'company_id' && args[1] === 'co-1'
      )
    )).toBe(true)
  })

  it('rejects a posted December root with visible storno and January correction children', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'posted',
      entry_date: '2025-12-15',
    })
    const { supabase } = makeSupabase([activePayment], [
      root,
      stornoEntry(root.id, '2025-12-15'),
      correctionEntry(root.id, '2026-01-15'),
    ])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(
      `Contradictory partial supplier payment journal lineage for posted entry ${root.id}`,
    )
  })

  it.each([
    { label: 'after cutoff', stornoDate: '2026-01-05', counted: true },
    { label: 'on cutoff', stornoDate: '2025-12-31', counted: false },
    { label: 'before cutoff', stornoDate: '2025-12-20', counted: false },
  ])('applies a plain supplier payment storno $label', async ({
    stornoDate,
    counted,
  }) => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const storno = stornoEntry(root.id, stornoDate, { id: 'storno-1' })
    const { supabase } = makeSupabase(
      [{
        ...activePayment,
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: storno.id,
      }],
      [root, storno],
    )

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.has('supplier-invoice-1')).toBe(counted)
    expect(result.hasRows).toEqual(new Set(['supplier-invoice-1']))
  })

  it('counts a January payment corrected into December at the December cutoff', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    const storno = stornoEntry(root.id, root.entry_date)
    const correction = correctionEntry(root.id, '2025-12-15')
    const { supabase } = makeSupabase(
      [{ ...activePayment, payment_date: '2026-01-15' }],
      [root, storno, correction],
    )

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
  })

  it('excludes a December payment corrected into January at the December cutoff', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      entry_date: '2025-12-15',
    })
    const storno = stornoEntry(root.id, root.entry_date)
    const correction = correctionEntry(root.id, '2026-01-15')
    const { supabase } = makeSupabase([activePayment], [root, storno, correction])

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

  it('traverses a future correction that was corrected back before cutoff', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      entry_date: '2025-01-15',
    })
    const futureCorrection = correctionEntry(root.id, '2026-01-15', {
      status: 'reversed',
    })
    const backdatedCorrection = correctionEntry(futureCorrection.id, '2025-12-20')
    const { supabase } = makeSupabase([activePayment], [
      root,
      stornoEntry(root.id, root.entry_date),
      futureCorrection,
      stornoEntry(futureCorrection.id, futureCorrection.entry_date),
      backdatedCorrection,
    ])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(500)
  })

  it('keeps payment_date behavior for legacy null journal links', async () => {
    const { supabase, calls } = makeSupabase([
      {
        ...activePayment,
        id: 'legacy-before',
        journal_entry_id: null,
        payment_date: '2025-12-31',
        amount: 200,
      },
      {
        ...activePayment,
        id: 'legacy-after',
        journal_entry_id: null,
        payment_date: '2026-01-01',
        amount: 300,
      },
    ])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(200)
    expect(calls.filter((call) => call.table === 'journal_entries')).toEqual([])
  })

  it('fails loudly when a linked supplier payment root is missing', async () => {
    const { supabase } = makeSupabase([activePayment])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Could not resolve 1 supplier payment journal entries/)
  })

  it('fails loudly when retained reversal journal lineage is missing', async () => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const { supabase } = makeSupabase([{
      ...activePayment,
      reversed_at: '2026-01-10T12:00:00Z',
      reversed_by_journal_entry_id: 'missing-storno',
    }], [root])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Malformed supplier payment reversal lineage/)
  })

  it('fails loudly when retained reversal journal lineage is malformed', async () => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const malformedStorno = stornoEntry('different-payment-entry', '2026-01-05', {
      id: 'storno-1',
    })
    const { supabase } = makeSupabase(
      [{
        ...activePayment,
        reversed_at: '2026-01-10T12:00:00Z',
        reversed_by_journal_entry_id: malformedStorno.id,
      }],
      [root, malformedStorno],
    )

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Malformed supplier payment reversal lineage/)
  })

  it('fails loudly for ambiguous correction lineage', async () => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const { supabase } = makeSupabase([activePayment], [
      root,
      stornoEntry(root.id, root.entry_date),
      correctionEntry(root.id, '2025-12-20'),
      correctionEntry(root.id, '2025-12-21'),
    ])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Ambiguous supplier payment correction lineage/)
  })

  it('fails loudly when the RPC exposes a lineage cycle', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      correction_of_id: 'correction-1',
    })
    const correction = correctionEntry(root.id, '2025-12-20', {
      id: 'correction-1',
      status: 'reversed',
    })
    const { supabase } = makeSupabase([activePayment], [root, correction])

    await expect(fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )).rejects.toThrow(/Cyclic supplier payment journal lineage/)
  })

  it('aggregates an active duplicate allocation pair with öre rounding', async () => {
    const { supabase } = makeSupabase([
      { ...activePayment, amount: 100.005 },
      { ...activePayment, id: 'payment-duplicate', amount: 100.005 },
    ], [journalEntry('payment-entry-1')])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(200.02)
  })

  it('collapses a duplicate allocation pair before applying its reversal', async () => {
    const root = journalEntry('payment-entry-1', { status: 'reversed' })
    const storno = stornoEntry(root.id, '2025-12-31', { id: 'storno-1' })
    const rows = [
      { ...activePayment, amount: 100.005 },
      { ...activePayment, id: 'payment-duplicate', amount: 100.005 },
    ].map((row) => ({
      ...row,
      reversed_at: '2026-01-10T12:00:00Z',
      reversed_by_journal_entry_id: storno.id,
    }))
    const { supabase } = makeSupabase(rows, [root, storno])

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

  it('collapses a duplicate allocation pair before following its correction', async () => {
    const root = journalEntry('payment-entry-1', {
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    const storno = stornoEntry(root.id, root.entry_date)
    const correction = correctionEntry(root.id, '2025-12-15')
    const { supabase } = makeSupabase([
      { ...activePayment, amount: 100.005, payment_date: '2026-01-15' },
      {
        ...activePayment,
        id: 'payment-duplicate',
        amount: 100.005,
        payment_date: '2026-01-15',
      },
    ], [root, storno, correction])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(200.02)
  })

  it('keeps one batch voucher allocated once across different invoices', async () => {
    const { supabase } = makeSupabase([
      activePayment,
      {
        ...activePayment,
        id: 'payment-2',
        supplier_invoice_id: 'supplier-invoice-2',
        amount: 300,
      },
    ], [journalEntry('payment-entry-1')])

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough).toEqual(new Map([
      ['supplier-invoice-1', 500],
      ['supplier-invoice-2', 300],
    ]))
  })

  it('batches lineage RPCs for 10,001 paginated allocations without changing totals', async () => {
    const paymentRows = Array.from({ length: 10_001 }, (_, index) => ({
      ...activePayment,
      id: `payment-${index}`,
      amount: 1,
      journal_entry_id: `entry-${index}`,
    }))
    const journalRows = Array.from({ length: 10_001 }, (_, index) =>
      journalEntry(`entry-${index}`),
    )
    const { supabase, calls, rpcCalls } = makeSupabase(paymentRows, journalRows)

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    expect(result.paidThrough.get('supplier-invoice-1')).toBe(10_001)
    expect(calls.map((call) => call.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
      [4000, 4999],
      [5000, 5999],
      [6000, 6999],
      [7000, 7999],
      [8000, 8999],
      [9000, 9999],
      [10000, 10999],
    ])
    expect(rpcCalls).toHaveLength(34)
    expect(rpcCalls.every((call) =>
      call.name === 'get_supplier_payment_lineage'
      && call.params.p_company_id === 'co-1'
      && call.params.p_root_ids.length <= 300
    )).toBe(true)
    expect(rpcCalls.flatMap((call) => call.params.p_root_ids)).toHaveLength(10_001)
    expect(calls).toHaveLength(11)
    expect(calls.every((call) => call.table === 'supplier_invoice_payments')).toBe(true)
  })

  it('merges more than 20,000 distinct roots exactly across bounded RPC calls', async () => {
    const rootCount = 20_001
    const paymentRows = Array.from({ length: rootCount }, (_, index) => ({
      ...activePayment,
      id: `payment-${index}`,
      supplier_invoice_id: `supplier-invoice-${index}`,
      amount: 1,
      journal_entry_id: `entry-${index}`,
    }))
    const journalRows = Array.from({ length: rootCount }, (_, index) =>
      journalEntry(`entry-${index}`),
    )
    const { supabase, rpcCalls } = makeSupabase(paymentRows, journalRows)

    const result = await fetchPaymentsAsOf(
      supabase as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2025-12-31',
    )

    const requestedRoots = rpcCalls.flatMap((call) => call.params.p_root_ids)
    expect(rpcCalls).toHaveLength(67)
    expect(rpcCalls.every((call) => call.params.p_root_ids.length <= 300)).toBe(true)
    expect(requestedRoots).toHaveLength(rootCount)
    expect(new Set(requestedRoots).size).toBe(rootCount)
    expect(result.paidThrough.size).toBe(rootCount)
    expect(new Set(result.paidThrough.values())).toEqual(new Set([1]))
  })

  it('leaves customer payment history unchanged and does not fetch journal lineage', async () => {
    const { supabase, calls } = makeSupabase([{
      id: 'customer-payment-1',
      company_id: 'co-1',
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
