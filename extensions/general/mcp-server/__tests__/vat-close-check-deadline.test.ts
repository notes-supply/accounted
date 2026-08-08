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
  findRcBasisGaps: vi.fn(async () => []),
}))

import { computeVatCloseCheck } from '../server'

interface FiscalPeriodFixture {
  id: string
  company_id: string
  period_start: string
  period_end: string
}

interface DeadlineSettingsFixture {
  moms_period: 'monthly' | 'quarterly' | 'yearly'
  entity_type: 'aktiebolag' | 'enskild_firma'
  vat_taxable_base_over_40m: boolean
  vat_has_eu_trade: boolean
  vat_filing_method: 'electronic' | 'paper'
  vat_liability_start_date: string | null
}

function mockSupabase(
  fiscalPeriods: FiscalPeriodFixture[],
  settings: DeadlineSettingsFixture,
  settingsError: { message: string } | null = null,
) {
  const fiscalPeriodFilters: Array<[string, unknown]> = []
  let companySettingsQueries = 0

  const makeEmptyChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: [], error: null, count: 0 }
    chain.range = () => settled
    chain.single = async () => ({ data: null, error: null })
    chain.maybeSingle = async () => ({ data: null, error: null })
    chain.then = (resolve: (value: unknown) => unknown) => resolve(settled)
    for (const method of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[method] = () => chain
    }
    return chain
  }

  const makeSettingsChain = (error: { message: string } | null): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = () => chain
    chain.single = async () => ({ data: error ? null : settings, error })
    chain.maybeSingle = async () => ({ data: error ? null : settings, error })
    return chain
  }

  const makeFiscalPeriodChain = (): Record<string, unknown> => {
    let rows = [...fiscalPeriods]
    let rowLimit: number | null = null
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (field: keyof FiscalPeriodFixture, value: unknown) => {
      fiscalPeriodFilters.push([field, value])
      rows = rows.filter((row) => row[field] === value)
      return chain
    }
    chain.gte = (field: keyof FiscalPeriodFixture, value: string) => {
      rows = rows.filter((row) => row[field] >= value)
      return chain
    }
    chain.lte = (field: keyof FiscalPeriodFixture, value: string) => {
      rows = rows.filter((row) => row[field] <= value)
      return chain
    }
    chain.order = (field: keyof FiscalPeriodFixture, options?: { ascending?: boolean }) => {
      rows.sort((a, b) => a[field].localeCompare(b[field]))
      if (options?.ascending === false) rows.reverse()
      return chain
    }
    chain.limit = (limit: number) => {
      rowLimit = limit
      return chain
    }
    chain.maybeSingle = async () => ({
      data: rows.slice(0, rowLimit ?? rows.length)[0] ?? null,
      error: null,
    })
    chain.then = (resolve: (value: unknown) => unknown) => resolve({
      data: rows.slice(0, rowLimit ?? rows.length),
      error: null,
    })
    return chain
  }

  return {
    supabase: {
      from: (table: string) => {
        if (table === 'company_settings') {
          const error = companySettingsQueries > 0 ? settingsError : null
          companySettingsQueries++
          return makeSettingsChain(error)
        }
        if (table === 'fiscal_periods') return makeFiscalPeriodChain()
        return makeEmptyChain()
      },
      rpc: (fn: string) =>
        fn === 'verifikat_without_documents'
          ? Promise.resolve({
              data: { ok: true, total_count: 0, verifikat: [] },
              error: null,
            })
          : makeEmptyChain(),
    } as never,
    fiscalPeriodFilters,
  }
}

describe('gnubok_vat_close_check: annual deadline parity', () => {
  it('uses the selected non-calendar fiscal period end and canonical annual settings', async () => {
    const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const fiscalPeriodId = '11111111-1111-4111-8111-111111111111'
    const { supabase, fiscalPeriodFilters } = mockSupabase([
      {
        id: fiscalPeriodId,
        company_id: companyId,
        period_start: '2025-07-01',
        period_end: '2026-06-30',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        company_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
      },
    ], {
      moms_period: 'yearly',
      entity_type: 'aktiebolag',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: false,
      vat_filing_method: 'electronic',
      vat_liability_start_date: null,
    })

    const result = await computeVatCloseCheck({
      period_type: 'yearly',
      year: 2026,
      period: 1,
      fiscal_period_id: fiscalPeriodId,
    }, companyId, supabase)

    expect(result.period).toMatchObject({
      start: '2025-07-01',
      end: '2026-06-30',
    })
    expect(result.payment).toMatchObject({
      deadline: '2027-01-18',
      deadline_label: '18 januari 2027',
      moms_period: 'yearly',
    })
    expect(fiscalPeriodFilters).toContainEqual(['id', fiscalPeriodId])
    expect(fiscalPeriodFilters).toContainEqual(['company_id', companyId])
  })

  it('preserves the canonical 26 February calendar-year case', async () => {
    const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const fiscalPeriodId = '33333333-3333-4333-8333-333333333333'
    const { supabase } = mockSupabase([{
      id: fiscalPeriodId,
      company_id: companyId,
      period_start: '2026-01-01',
      period_end: '2026-12-31',
    }], {
      moms_period: 'yearly',
      entity_type: 'enskild_firma',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: true,
      vat_filing_method: 'electronic',
      vat_liability_start_date: null,
    })

    const result = await computeVatCloseCheck({
      period_type: 'yearly',
      year: 2026,
      period: 1,
      fiscal_period_id: fiscalPeriodId,
    }, companyId, supabase)

    expect(result.payment).toMatchObject({
      deadline: '2027-02-26',
      deadline_label: '26 februari 2027',
      moms_period: 'yearly',
    })
  })

  it('keeps the uniquely resolved actual fiscal period when no id is supplied', async () => {
    const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { supabase } = mockSupabase([{
      id: '44444444-4444-4444-8444-444444444444',
      company_id: companyId,
      period_start: '2025-07-01',
      period_end: '2026-06-30',
    }], {
      moms_period: 'yearly',
      entity_type: 'aktiebolag',
      vat_taxable_base_over_40m: false,
      vat_has_eu_trade: false,
      vat_filing_method: 'electronic',
      vat_liability_start_date: null,
    })

    const result = await computeVatCloseCheck({
      period_type: 'yearly', year: 2026, period: 1,
    }, companyId, supabase)

    expect(result.period).toMatchObject({ start: '2025-07-01', end: '2026-06-30' })
    expect(result.payment).toMatchObject({
      deadline: '2027-01-18',
      deadline_label: '18 januari 2027',
    })
  })
})

describe('gnubok_vat_close_check: canonical recurring deadlines', () => {
  const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const baseSettings: DeadlineSettingsFixture = {
    moms_period: 'monthly',
    entity_type: 'aktiebolag',
    vat_taxable_base_over_40m: false,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic',
    vat_liability_start_date: null,
  }

  it('uses the second following month at or below SEK 40 million', async () => {
    const { supabase } = mockSupabase([], baseSettings)

    const result = await computeVatCloseCheck({
      period_type: 'monthly', year: 2026, period: 3,
    }, companyId, supabase)

    expect(result.payment).toMatchObject({
      deadline: '2026-05-12',
      deadline_label: '12 maj 2026',
    })
  })

  it('uses the following month and 26th above SEK 40 million', async () => {
    const { supabase } = mockSupabase([], {
      ...baseSettings,
      vat_taxable_base_over_40m: true,
    })

    const result = await computeVatCloseCheck({
      period_type: 'monthly', year: 2026, period: 1,
    }, companyId, supabase)

    expect(result.payment).toMatchObject({
      deadline: '2026-02-26',
      deadline_label: '26 februari 2026',
    })
  })

  it.each([
    { quarter: 1, date: '2026-05-12', label: '12 maj 2026' },
    { quarter: 2, date: '2026-08-17', label: '17 augusti 2026' },
    { quarter: 3, date: '2026-11-12', label: '12 november 2026' },
    { quarter: 4, date: '2027-02-12', label: '12 februari 2027' },
  ])('uses the canonical quarterly deadline for Q$quarter', async ({ quarter, date, label }) => {
    const { supabase } = mockSupabase([], { ...baseSettings, moms_period: 'quarterly' })

    const result = await computeVatCloseCheck({
      period_type: 'quarterly', year: 2026, period: quarter,
    }, companyId, supabase)

    expect(result.payment).toMatchObject({ deadline: date, deadline_label: label })
  })

  it('moves a recurring deadline to the next Swedish banking day', async () => {
    const { supabase } = mockSupabase([], baseSettings)

    const result = await computeVatCloseCheck({
      period_type: 'monthly', year: 2026, period: 11,
    }, companyId, supabase)

    expect(result.payment).toMatchObject({
      deadline: '2027-01-18',
      deadline_label: '18 januari 2027',
    })
  })

  it.each([
    { periodType: 'monthly', error: { message: 'connection reset' } },
    { periodType: 'quarterly', error: { message: 'JSON object requested, multiple rows returned' } },
  ])('fails closed on $periodType settings query errors', async ({ periodType, error }) => {
    const { supabase } = mockSupabase([], {
      ...baseSettings,
      moms_period: periodType as 'monthly' | 'quarterly',
    }, error)

    await expect(computeVatCloseCheck({
      period_type: periodType, year: 2026, period: 1,
    }, companyId, supabase)).rejects.toThrow(/Failed to resolve VAT deadline settings/)
  })
})
