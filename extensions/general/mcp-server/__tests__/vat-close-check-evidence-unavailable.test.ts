import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: vi.fn(async () => {
    throw new Error('evidence query failed')
  }),
}))

import { computeVatCloseCheck } from '../server'

const VAT_SETTINGS = {
  moms_period: 'monthly', entity_type: 'aktiebolag',
  vat_taxable_base_over_40m: false, vat_has_eu_trade: false,
  vat_filing_method: 'electronic', vat_liability_start_date: null,
}

function mockSupabase() {
  const insert = vi.fn()
  const update = vi.fn()
  const upsert = vi.fn()
  const deleteRows = vi.fn()

  const makeChain = (singleRow: unknown = null): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: [], error: null, count: 0 }
    chain.range = () => settled
    chain.single = async () => ({ data: singleRow, error: null })
    chain.maybeSingle = async () => ({ data: singleRow, error: null })
    chain.then = (resolve: (value: unknown) => unknown) => resolve(settled)
    for (const method of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[method] = () => chain
    }
    chain.insert = insert
    chain.update = update
    chain.upsert = upsert
    chain.delete = deleteRows
    return chain
  }

  return {
    supabase: {
      from: (table: string) => makeChain(table === 'company_settings' ? VAT_SETTINGS : null),
      rpc: (fn: string) =>
        fn === 'verifikat_without_documents'
          ? Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
          : makeChain(),
    } as never,
    mutations: { insert, update, upsert, deleteRows },
  }
}

describe('gnubok_vat_close_check: unavailable required evidence', () => {
  it('returns not ready with a stable high blocker and performs no writes', async () => {
    const { supabase, mutations } = mockSupabase()

    const result = await computeVatCloseCheck(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(result.ready_to_close).toBe(false)
    expect(result.summary).not.toContain('Klart för stängning')
    expect(result.declaration_checks).toContainEqual(expect.objectContaining({
      code: 'RC_BASIS_SCAN_UNAVAILABLE',
      status: 'ERROR',
    }))
    expect(result.blockers).toContainEqual(expect.objectContaining({
      check_code: 'RC_BASIS_SCAN_UNAVAILABLE',
      severity: 'high',
    }))
    expect(mutations.insert).not.toHaveBeenCalled()
    expect(mutations.update).not.toHaveBeenCalled()
    expect(mutations.upsert).not.toHaveBeenCalled()
    expect(mutations.deleteRows).not.toHaveBeenCalled()
  })
})
