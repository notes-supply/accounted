import { describe, expect, it, vi } from 'vitest'
import type {
  JournalLineageEnvelope,
  JournalLineageNode,
} from '../reskontra-payments'
import {
  fetchEffectiveJournalEntriesAsOf,
  fetchPaymentsAsOf,
  reconstructReskontraAsOf,
} from '../reskontra-payments'

interface LineageInputNode {
  id: string
  parent_id?: string
  edge_kind?: 'correction' | 'storno'
  entry_date?: string
  committed_at?: string
}

interface MockConfig {
  tables?: Record<string, Array<Record<string, unknown>>>
  lineages?: Map<string, JournalLineageNode[]>
  mutateEnvelope?: (envelope: JournalLineageEnvelope) => unknown
}

function lineage(rootId: string, input: LineageInputNode[]): JournalLineageNode[] {
  const byId = new Map(input.map((row) => [row.id, row]))
  const stornoByParent = new Map(
    input
      .filter((row) => row.edge_kind === 'storno')
      .map((row) => [row.parent_id!, row.id]),
  )

  const pathFor = (row: LineageInputNode): string[] => {
    if (!row.parent_id) return [row.id]
    const parent = byId.get(row.parent_id)
    if (!parent) throw new Error(`Missing fixture parent ${row.parent_id}`)
    return [...pathFor(parent), row.id]
  }

  return input.map((row) => {
    const path = pathFor(row)
    const edgeKind = row.edge_kind ?? 'root'
    const stornoId = stornoByParent.get(row.id) ?? null
    return {
      root_id: rootId,
      parent_id: row.parent_id ?? null,
      edge_kind: edgeKind,
      id: row.id,
      company_id: 'co-1',
      entry_date: row.entry_date ?? '2026-01-10',
      status: edgeKind !== 'storno' && stornoId ? 'reversed' : 'posted',
      source_type: edgeKind === 'root' ? 'supplier_invoice_paid' : edgeKind,
      correction_of_id: edgeKind === 'correction' ? row.parent_id! : null,
      reverses_id: edgeKind === 'storno' ? row.parent_id! : null,
      reversed_by_id: edgeKind === 'storno' ? null : stornoId,
      committed_at: row.committed_at ?? '2026-01-10T12:00:00Z',
      depth: path.length - 1,
      path,
      cycle: false,
    }
  })
}

function envelope(rootIds: string[], lineages: Map<string, JournalLineageNode[]>) {
  const rows = rootIds.flatMap((rootId) => lineages.get(rootId) ?? [])
  const stornoDepths = rows
    .filter((row) => row.edge_kind === 'storno')
    .map((row) => row.depth)
  return {
    valid: true,
    company_id: 'co-1',
    requested_root_count: rootIds.length,
    row_count: rows.length,
    max_depth: Math.max(...rows.map((row) => row.depth)),
    max_correction_depth: Math.max(
      ...rows.filter((row) => row.edge_kind !== 'storno').map((row) => row.depth),
    ),
    terminal_storno_depth: stornoDepths.length > 0
      ? Math.max(...stornoDepths)
      : null,
    rows,
  } satisfies JournalLineageEnvelope
}

function makeSupabase(config: MockConfig) {
  const rpc = vi.fn(async (name: string, args: { p_root_ids: string[] }) => {
    if (name !== 'get_journal_lineage') {
      return { data: null, error: { message: `Unexpected RPC ${name}` } }
    }
    const data = envelope(args.p_root_ids, config.lineages ?? new Map())
    return {
      data: config.mutateEnvelope ? config.mutateEnvelope(data) : data,
      error: null,
    }
  })
  const from = vi.fn((table: string) => {
    let rangeStart = 0
    let rangeEnd = 999
    const query: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'order']) {
      query[method] = vi.fn(() => query)
    }
    query.range = vi.fn((start: number, end: number) => {
      rangeStart = start
      rangeEnd = end
      return query
    })
    query.then = (resolve: (value: unknown) => unknown) => resolve({
      data: (config.tables?.[table] ?? []).slice(rangeStart, rangeEnd + 1),
      error: null,
    })
    return query
  })
  return { from, rpc }
}

describe('reskontra as-of reconstruction', () => {
  it('combines active and retained payments and applies terminal storno by cutoff', async () => {
    const lineages = new Map([
      ['pay-active', lineage('pay-active', [{ id: 'pay-active' }])],
      ['pay-retained', lineage('pay-retained', [
        { id: 'pay-retained' },
        {
          id: 'pay-retained-storno',
          parent_id: 'pay-retained',
          edge_kind: 'storno',
          entry_date: '2026-07-01',
          committed_at: '2026-07-02T08:00:00Z',
        },
      ])],
    ])
    const tables = {
      supplier_invoice_payments: [{
        id: 'active', supplier_invoice_id: 'si-1', amount: 300,
        payment_date: '2026-02-01', journal_entry_id: 'pay-active',
      }],
      supplier_invoice_payment_history: [{
        original_payment_id: 'retained', supplier_invoice_id: 'si-1', amount: 200,
        payment_date: '2026-02-10', journal_entry_id: 'pay-retained',
        lineage_root_journal_entry_id: 'pay-retained',
        reversed_live_journal_entry_id: 'pay-retained',
        reversed_by_journal_entry_id: 'pay-retained-storno',
      }],
    }

    const beforeStorno = await fetchPaymentsAsOf(
      makeSupabase({ tables, lineages }) as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-06-30',
    )
    expect(beforeStorno.hasRows.has('si-1')).toBe(true)
    expect(beforeStorno.paidThrough.get('si-1')).toBe(500)

    const afterStorno = await fetchPaymentsAsOf(
      makeSupabase({ tables, lineages }) as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-07-31',
    )
    expect(afterStorno.paidThrough.get('si-1')).toBe(300)
  })

  it('keeps a root-owned allocation live through its exact correction branch', async () => {
    const lineages = new Map([
      ['pay-root', lineage('pay-root', [
        { id: 'pay-root' },
        {
          id: 'pay-root-storno', parent_id: 'pay-root', edge_kind: 'storno',
          entry_date: '2026-03-02', committed_at: '2026-03-02T09:00:00Z',
        },
        {
          id: 'pay-correction', parent_id: 'pay-root', edge_kind: 'correction',
          entry_date: '2026-03-02', committed_at: '2026-03-02T09:00:00Z',
        },
      ])],
    ])
    const client = makeSupabase({
      lineages,
      tables: {
        supplier_invoice_payments: [{
          id: 'allocation', supplier_invoice_id: 'si-1', amount: 250,
          payment_date: '2026-03-01', journal_entry_id: 'pay-root',
        }],
        supplier_invoice_payment_history: [],
      },
    })

    const result = await fetchPaymentsAsOf(
      client as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-03-31',
    )

    expect(result.paidThrough.get('si-1')).toBe(250)
    expect(client.rpc).toHaveBeenCalledWith('get_journal_lineage', {
      p_company_id: 'co-1',
      p_root_ids: ['pay-root'],
    })
    expect(client.from).not.toHaveBeenCalledWith('journal_entries')
  })

  it('accepts an exact correction-owned retained allocation and validates its storno', async () => {
    const lineages = new Map([
      ['pay-root', lineage('pay-root', [
        { id: 'pay-root' },
        {
          id: 'root-storno', parent_id: 'pay-root', edge_kind: 'storno',
          entry_date: '2026-03-02', committed_at: '2026-03-02T09:00:00Z',
        },
        {
          id: 'pay-correction', parent_id: 'pay-root', edge_kind: 'correction',
          entry_date: '2026-03-02', committed_at: '2026-03-02T09:00:00Z',
        },
        {
          id: 'correction-storno', parent_id: 'pay-correction', edge_kind: 'storno',
          entry_date: '2026-07-01', committed_at: '2026-07-01T09:00:00Z',
        },
      ])],
    ])
    const tables = {
      supplier_invoice_payments: [],
      supplier_invoice_payment_history: [{
        original_payment_id: 'retained', supplier_invoice_id: 'si-1', amount: 250,
        payment_date: '2026-03-01', journal_entry_id: 'pay-correction',
        lineage_root_journal_entry_id: 'pay-root',
        reversed_live_journal_entry_id: 'pay-correction',
        reversed_by_journal_entry_id: 'correction-storno',
      }],
    }

    const beforeTerminalStorno = await fetchPaymentsAsOf(
      makeSupabase({ tables, lineages }) as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-06-30',
    )
    expect(beforeTerminalStorno.paidThrough.get('si-1')).toBe(250)

    const afterTerminalStorno = await fetchPaymentsAsOf(
      makeSupabase({ tables, lineages }) as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-07-31',
    )
    expect(afterTerminalStorno.paidThrough.has('si-1')).toBe(false)
  })

  it('uses envelope commit time to exclude posted-later roots and descendants', async () => {
    const lineages = new Map([
      ['posted-later', lineage('posted-later', [{
        id: 'posted-later',
        entry_date: '2026-05-01',
        committed_at: '2026-07-01T08:00:00Z',
      }])],
      ['registration-root', lineage('registration-root', [
        { id: 'registration-root' },
        {
          id: 'registration-storno', parent_id: 'registration-root', edge_kind: 'storno',
          entry_date: '2026-05-15', committed_at: '2026-07-01T08:00:00Z',
        },
        {
          id: 'current-correction', parent_id: 'registration-root', edge_kind: 'correction',
          entry_date: '2026-05-15', committed_at: '2026-07-01T08:00:00Z',
        },
      ])],
    ])
    const client = makeSupabase({ lineages })
    const effective = await fetchEffectiveJournalEntriesAsOf(
      client as never,
      'co-1',
      ['posted-later', 'registration-root'],
      '2026-06-30',
    )

    expect(effective.get('posted-later')?.effective).toBe(false)
    expect(effective.get('registration-root')).toEqual({
      effective: true,
      rootId: 'registration-root',
      entryId: 'registration-root',
      entryDate: '2026-01-10',
      terminalStornoId: null,
    })
  })

  it('returns one signed population for originals, credits, and source exclusion', async () => {
    const lineages = new Map([
      ['reg-original', lineage('reg-original', [{ id: 'reg-original' }])],
      ['reg-credit', lineage('reg-credit', [{ id: 'reg-credit' }])],
      ['booked-credit', lineage('booked-credit', [{ id: 'booked-credit' }])],
    ])
    const result = await reconstructReskontraAsOf(
      makeSupabase({ lineages }) as never,
      'co-1',
      '2026-06-30',
      'supplier_invoice_payments',
      'supplier_invoice_id',
      [
        {
          id: 'original', total: 1000, liveOutstanding: 1000,
          registrationEvidence: 'required', registrationJournalEntryId: 'reg-original',
        },
        {
          id: 'credit', total: 250, liveOutstanding: 250, sign: -1,
          registrationEvidence: 'required', registrationJournalEntryId: 'reg-credit',
        },
        {
          id: 'already-booked-credit', total: 100, liveOutstanding: 100, sign: -1,
          sourceJournalEntryId: 'booked-credit', excludeWhenSourceEffective: true,
        },
      ],
    )

    expect([...result.outstandingByInvoice.entries()]).toEqual([
      ['original', 1000],
      ['credit', -250],
    ])
  })

  it('fails closed on malformed generic envelope counts', async () => {
    const lineages = new Map([
      ['root', lineage('root', [{ id: 'root' }])],
    ])
    await expect(fetchEffectiveJournalEntriesAsOf(
      makeSupabase({
        lineages,
        mutateEnvelope: (value) => ({ ...value, row_count: 2 }),
      }) as never,
      'co-1',
      ['root'],
      '2026-12-31',
    )).rejects.toThrow(/invalid envelope/)
  })

  it('fails closed when retained reversal identity is not the terminal branch', async () => {
    const lineages = new Map([
      ['root', lineage('root', [
        { id: 'root' },
        { id: 'storno', parent_id: 'root', edge_kind: 'storno' },
      ])],
    ])
    await expect(fetchPaymentsAsOf(
      makeSupabase({
        lineages,
        tables: {
          supplier_invoice_payments: [],
          supplier_invoice_payment_history: [{
            original_payment_id: 'retained', supplier_invoice_id: 'si-1', amount: 100,
            payment_date: '2026-01-01', journal_entry_id: 'root',
            lineage_root_journal_entry_id: 'root',
            reversed_live_journal_entry_id: 'root',
            reversed_by_journal_entry_id: 'wrong-storno',
          }],
        },
      }) as never,
      'supplier_invoice_payments',
      'supplier_invoice_id',
      'co-1',
      '2026-12-31',
    )).rejects.toThrow(/invalid reversal identity/)
  })
})
