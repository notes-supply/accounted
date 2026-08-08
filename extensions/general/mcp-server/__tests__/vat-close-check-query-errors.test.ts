import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = { period_type: 'monthly', year: 2026, period: 1 }
const VAT_SETTINGS = {
  moms_period: 'monthly', entity_type: 'aktiebolag',
  vat_taxable_base_over_40m: false, vat_has_eu_trade: false,
  vat_filing_method: 'electronic', vat_liability_start_date: null,
}

function mockSupabase(failingTable: 'transactions' | 'supplier_invoices') {
  const insert = vi.fn()
  const update = vi.fn()
  const upsert = vi.fn()
  const deleteRows = vi.fn()

  const makeChain = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const error = table === failingTable ? { message: 'fetch failed' } : null
    const settled = { data: [], error, count: error ? null : 0 }
    chain.range = () => settled
    const singleRow = table === 'company_settings' ? VAT_SETTINGS : null
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
      from: (table: string) => makeChain(table),
      rpc: (fn: string) =>
        fn === 'verifikat_without_documents'
          ? Promise.resolve({
              data: { ok: true, total_count: 0, verifikat: [] },
              error: null,
            })
          : makeChain('rpc'),
    } as never,
    mutations: { insert, update, upsert, deleteRows },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_vat_close_check: blocker-query failures', () => {
  it('fails closed when uncategorized transaction evidence is unavailable', async () => {
    const { supabase, mutations } = mockSupabase('transactions')

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      'VAT close check unavailable: failed to count uncategorized transactions: fetch failed',
    )
    expect(mutations.insert).not.toHaveBeenCalled()
    expect(mutations.update).not.toHaveBeenCalled()
    expect(mutations.upsert).not.toHaveBeenCalled()
    expect(mutations.deleteRows).not.toHaveBeenCalled()
  })

  it('fails closed when unapproved supplier invoice evidence is unavailable', async () => {
    const { supabase, mutations } = mockSupabase('supplier_invoices')

    await expect(computeVatCloseCheck(PERIOD, COMPANY_ID, supabase)).rejects.toThrow(
      'VAT close check unavailable: failed to count unapproved supplier invoices: fetch failed',
    )
    expect(mutations.insert).not.toHaveBeenCalled()
    expect(mutations.update).not.toHaveBeenCalled()
    expect(mutations.upsert).not.toHaveBeenCalled()
    expect(mutations.deleteRows).not.toHaveBeenCalled()
  })
})
