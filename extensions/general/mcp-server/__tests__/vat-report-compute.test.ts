/**
 * Focused tests for computeVatReport: the shared VAT computation used by
 * gnubok_get_vat_report and gnubok_vat_review_widget. These exist because the
 * tools/call integration tests can't reach into the rutor math; this file
 * mocks Supabase to feed synthetic journal entry lines and asserts the rutor
 * shape, ruta48 inclusion of 2647, ruta49 formula, and the one-sided
 * reverse-charge warning.
 */
import { describe, it, expect } from 'vitest'
import { computeVatReport, tools } from '../server'

interface MockLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entry_id?: string
  journal_entries?: { source_type: string | null }
}

function mockSupabaseWithLines(
  lines: MockLine[],
  options: {
    fiscalPeriod?: { period_start: string; period_end: string } | null
    fiscalPeriods?: Array<{
      id: string
      company_id: string
      period_start: string
      period_end: string
    }>
    vatLiabilityStartDate?: string | null
  } = {},
) {
  // computeVatReport uses the two-step entry-lines fetch
  // (lib/bookkeeping/entry-lines.ts): journal_entries is queried first, then
  // journal_entry_lines by parent id, and the parent is reattached under
  // `journal_entries`. Both steps page with `.order('id').range(from, to)`,
  // so `.range()` is the terminal; one short page (always < the 1000-row
  // PAGE_SIZE for these fixtures) ends the paging loop.
  //
  // Fixtures stay line-shaped for readability; the parent rows are derived
  // from them here.
  const entries = [
    ...new Map(
      lines.map((l, i) => {
        const id = l.journal_entry_id ?? `entry-${i}`
        return [id, { id, source_type: l.journal_entries?.source_type ?? null }]
      }),
    ).values(),
  ]
  const bareLines = lines.map((l, i) => ({
    id: `line-${String(i).padStart(4, '0')}`,
    journal_entry_id: l.journal_entry_id ?? `entry-${i}`,
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
  }))

  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, () => unknown> = {}
    chain.range = () => ({ data: rows, error: null })
    for (const m of ['order', 'lte', 'gte', 'neq', 'in', 'not', 'eq', 'select', 'limit', 'contains', 'filter']) {
      chain[m] = () => chain
    }
    return chain
  }

  const makeSingleChain = (data: unknown) => {
    const chain: Record<string, () => unknown> = {}
    chain.maybeSingle = () => ({ data, error: null })
    for (const m of ['order', 'lte', 'gte', 'eq', 'select', 'limit']) {
      chain[m] = () => chain
    }
    return chain
  }

  const fiscalPeriods = options.fiscalPeriods ?? (options.fiscalPeriod
    ? [{ id: 'fp-default', company_id: 'company-1', ...options.fiscalPeriod }]
    : [])
  const makeFiscalPeriodChain = () => {
    let rows = [...fiscalPeriods]
    let rowLimit: number | null = null
    const chain: Record<string, (...args: never[]) => unknown> = {}
    chain.select = () => chain
    chain.eq = ((field: string, value: unknown) => {
      rows = rows.filter((row) => row[field as keyof typeof row] === value)
      return chain
    }) as never
    chain.gte = ((field: string, value: string) => {
      rows = rows.filter((row) => String(row[field as keyof typeof row]) >= value)
      return chain
    }) as never
    chain.lte = ((field: string, value: string) => {
      rows = rows.filter((row) => String(row[field as keyof typeof row]) <= value)
      return chain
    }) as never
    chain.order = ((field: string, options?: { ascending?: boolean }) => {
      rows.sort((a, b) => String(a[field as keyof typeof a]).localeCompare(String(b[field as keyof typeof b])))
      if (options?.ascending === false) rows.reverse()
      return chain
    }) as never
    chain.limit = ((limit: number) => {
      rowLimit = limit
      return chain
    }) as never
    chain.maybeSingle = () => ({ data: rows.slice(0, rowLimit ?? rows.length)[0] ?? null, error: null })
    chain.then = ((resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows.slice(0, rowLimit ?? rows.length), error: null }).then(resolve)) as never
    return chain
  }

  return {
    // chart_of_accounts feeds fetchDynamicRuta05Accounts (the company's own
    // ruta 05 konton). Empty here: these fixtures are plain BAS charts, and the
    // dynamic path has its own coverage in lib/reports/__tests__.
    from: vi.fn((table: string) => {
      if (table === 'journal_entries') return makeChain(entries)
      if (table === 'chart_of_accounts') return makeChain([])
      if (table === 'fiscal_periods') return makeFiscalPeriodChain()
      if (table === 'company_settings') {
        return makeSingleChain({
          vat_liability_start_date: options.vatLiabilityStartDate ?? null,
        })
      }
      return makeChain(bareLines)
    }),
  } as never
}

describe('computeVatReport', () => {
  it('rejects yearly period values other than 1', async () => {
    await expect(computeVatReport(
      { period_type: 'yearly', year: 2026, period: 2 },
      'company-1',
      mockSupabaseWithLines([]),
    )).rejects.toThrow('period must be 1 for yearly')
  })

  it('uses the fiscal year and clamps the first annual period to VAT liability', async () => {
    const result = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines([], {
        fiscalPeriod: { period_start: '2026-04-15', period_end: '2026-12-31' },
        vatLiabilityStartDate: '2026-05-01',
      }),
    )

    expect(result.period.start).toBe('2026-05-01')
    expect(result.period.end).toBe('2026-12-31')
  })

  it('selects the requested earlier fiscal period when two periods end in the same year', async () => {
    const earlierId = '11111111-1111-4111-8111-111111111111'
    const laterId = '22222222-2222-4222-8222-222222222222'
    const result = await computeVatReport(
      {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        fiscal_period_id: earlierId,
      },
      'company-1',
      mockSupabaseWithLines([], {
        fiscalPeriods: [
          {
            id: earlierId,
            company_id: 'company-1',
            period_start: '2025-01-01',
            period_end: '2026-03-31',
          },
          {
            id: laterId,
            company_id: 'company-1',
            period_start: '2026-04-01',
            period_end: '2026-12-31',
          },
        ],
      }),
    )

    expect(result.period).toMatchObject({
      start: '2025-01-01',
      end: '2026-03-31',
    })
  })

  it('fails closed when an annual year matches more than one fiscal period without an id', async () => {
    await expect(computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines([], {
        fiscalPeriods: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            company_id: 'company-1',
            period_start: '2025-01-01',
            period_end: '2026-03-31',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            company_id: 'company-1',
            period_start: '2026-04-01',
            period_end: '2026-12-31',
          },
        ],
      }),
    )).rejects.toThrow(/fiscal_period_id is required/)
  })

  it('rejects a cross-company fiscal period id instead of redirecting the annual report', async () => {
    const crossCompanyId = '33333333-3333-4333-8333-333333333333'
    await expect(computeVatReport(
      {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        fiscal_period_id: crossCompanyId,
      },
      'company-1',
      mockSupabaseWithLines([], {
        fiscalPeriods: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            company_id: 'company-1',
            period_start: '2026-04-01',
            period_end: '2026-12-31',
          },
          {
            id: crossCompanyId,
            company_id: 'company-2',
            period_start: '2025-01-01',
            period_end: '2026-03-31',
          },
        ],
      }),
    )).rejects.toThrow(/No fiscal period found/)
  })

  it('rejects a fiscal period id that does not end in the requested year', async () => {
    const fiscalPeriodId = '44444444-4444-4444-8444-444444444444'
    await expect(computeVatReport(
      {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        fiscal_period_id: fiscalPeriodId,
      },
      'company-1',
      mockSupabaseWithLines([], {
        fiscalPeriods: [{
          id: fiscalPeriodId,
          company_id: 'company-1',
          period_start: '2025-01-01',
          period_end: '2025-12-31',
        }],
      }),
    )).rejects.toThrow(/does not end in 2026/)
  })

  it('aggregates 2611 → ruta10, 2641 → ruta48, includes 2647 → ruta48', async () => {
    const lines: MockLine[] = [
      // Domestic 25% sale: 1000 + 250 VAT
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      // Domestic input VAT 25%
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      // Domestic reverse-charge input VAT (2647)
      { account_number: '2647', debit_amount: 50, credit_amount: 0 },
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)
    expect(result.rutor.ruta10).toBe(250)
    expect(result.rutor.ruta11).toBe(0)
    expect(result.rutor.ruta12).toBe(0)
    // Ruta 48 = 2641 (100) + 2647 (50) = 150
    expect(result.rutor.ruta48).toBe(150)
    // Ruta 49 = 250 - 150 = 100 (positive = pay)
    expect(result.rutor.ruta49).toBe(100)
    expect(result.summary).toContain('Moms att betala')
    expect(result.warnings).toEqual([])
  })

  it('aggregates reverse-charge output VAT into ruta30/31/32 and the ruta49 formula', async () => {
    const lines: MockLine[] = [
      // Reverse-charge purchase 25%: both sides booked correctly
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },  // ruta30
      { account_number: '2645', debit_amount: 500, credit_amount: 0 },  // matching input → ruta48
      // Reverse-charge purchase 6%
      { account_number: '2634', debit_amount: 0, credit_amount: 30 },   // ruta32
      { account_number: '2645', debit_amount: 30, credit_amount: 0 },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta31).toBe(0)
    expect(result.rutor.ruta32).toBe(30)
    expect(result.rutor.ruta48).toBe(530) // 500 + 30 from 2645
    // Ruta 49 = (10+11+12+30+31+32) - 48 = 0+0+0+500+0+30 - 530 = 0
    expect(result.rutor.ruta49).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('emits a one-sided-reverse-charge warning when 2614 is booked without 2645 OR 2647', async () => {
    const lines: MockLine[] = [
      // Output booked but matching input missing (the most common reverse-charge error)
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },
      // Neither 2645 nor 2647 present
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta48).toBe(0)
    // Without the matching input, ruta49 is inflated by 500: the warning surfaces this.
    expect(result.rutor.ruta49).toBe(500)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/Omvänd betalningsskyldighet/)
    // Both 2645 (EU) and 2647 (domestic) are mentioned so users know what to look for.
    expect(result.warnings[0]).toMatch(/2645/)
    expect(result.warnings[0]).toMatch(/2647/)
  })

  it('does NOT warn when reverse-charge output is balanced by 2647 (domestic, no 2645)', async () => {
    // Domestic reverse charge per ML 16:13 (byggtjänster, electronics > 100k SEK):     // matching input lands on 2647, not 2645. The earlier check missed this.
    const lines: MockLine[] = [
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },  // ruta30
      { account_number: '2647', debit_amount: 500, credit_amount: 0 },  // domestic input → ruta48
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta48).toBe(500)
    expect(result.rutor.ruta49).toBe(0)
    // No warning: the domestic mirror is correctly booked.
    expect(result.warnings).toEqual([])
  })

  it('expanded ruta05 includes alternative BAS revenue accounts (3041/3051/3071) AND taxable EU goods (3106)', async () => {
    const lines: MockLine[] = [
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3041', debit_amount: 0, credit_amount: 500 },  // service 25%
      { account_number: '3051', debit_amount: 0, credit_amount: 300 },  // goods 25%
      { account_number: '3071', debit_amount: 0, credit_amount: 200 },  // other domestic
      { account_number: '3106', debit_amount: 0, credit_amount: 100 },  // momspliktig EU goods
    ]

    const result = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines, {
        fiscalPeriod: { period_start: '2026-01-01', period_end: '2026-12-31' },
      })
    )

    expect(result.rutor.ruta05).toBe(2100)
  })

  it('excludes 3004 (momsfri) from ruta05: exempt sales must NOT be in the taxable base', async () => {
    const lines: MockLine[] = [
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3004', debit_amount: 0, credit_amount: 500 }, // exempt: must be excluded
    ]

    const result = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines, {
        fiscalPeriod: { period_start: '2026-01-01', period_end: '2026-12-31' },
      })
    )

    expect(result.rutor.ruta05).toBe(1000)
  })

  it('aggregates 3108 → ruta35 (EU intra-community goods, momsfri leverans till EU)', async () => {
    const lines: MockLine[] = [
      // Domestic taxable sale
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      // EU goods supply, momsfri (zero-rated to EU customer with valid VAT number)
      { account_number: '3108', debit_amount: 0, credit_amount: 5000 },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)        // 3108 NOT in ruta05 (it's reported separately)
    expect(result.rutor.ruta35).toBe(5000)        // The new ruta we just added
    expect(result.rutor.ruta39).toBe(0)
    expect(result.rutor.ruta40).toBe(0)
  })

  it('excludes a manual settlement-shaped entry from the rutor (#984)', async () => {
    const lines: MockLine[] = [
      // Business activity on e1.
      { journal_entry_id: 'e1', account_number: '3001', debit_amount: 0, credit_amount: 1000, journal_entries: { source_type: 'invoice_created' } },
      { journal_entry_id: 'e1', account_number: '2611', debit_amount: 0, credit_amount: 250, journal_entries: { source_type: 'invoice_created' } },
      // Manual momsomföring on e2 (no vat_settlement tag): would zero ruta10.
      { journal_entry_id: 'e2', account_number: '2611', debit_amount: 250, credit_amount: 0, journal_entries: { source_type: 'manual' } },
      { journal_entry_id: 'e2', account_number: '2650', debit_amount: 0, credit_amount: 250, journal_entries: { source_type: 'manual' } },
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)
    expect(result.rutor.ruta10).toBe(250)
    expect(result.rutor.ruta49).toBe(250)
  })

  it('settlement-shape exclusion covers stornos and exempts opening balances', async () => {
    const lines: MockLine[] = [
      // Storno of a settlement: must be excluded from ruta10.
      { journal_entry_id: 'e3', account_number: '2611', debit_amount: 0, credit_amount: 100, journal_entries: { source_type: 'storno' } },
      { journal_entry_id: 'e3', account_number: '2650', debit_amount: 100, credit_amount: 0, journal_entries: { source_type: 'storno' } },
      // Opening balance carrying undeclared input VAT and a prior VAT debt:
      // stays IN the projection.
      { journal_entry_id: 'ib', account_number: '2641', debit_amount: 500, credit_amount: 0, journal_entries: { source_type: 'opening_balance' } },
      { journal_entry_id: 'ib', account_number: '2650', debit_amount: 0, credit_amount: 300, journal_entries: { source_type: 'opening_balance' } },
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta10).toBe(0)
    expect(result.rutor.ruta48).toBe(500)
    expect(result.rutor.ruta49).toBe(-500)
  })

  it('refund summary string when ruta49 is negative', async () => {
    const lines: MockLine[] = [
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      // No output VAT; pure refund position.
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta49).toBe(-100)
    expect(result.summary).toContain('Moms att få tillbaka')
  })

  it('exposes a rich outputSchema on both VAT tools (not bare {type:object})', () => {
    for (const name of ['gnubok_get_vat_report', 'gnubok_vat_review_widget']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, `tool ${name}`).toBeDefined()
      const schema = tool!.outputSchema as Record<string, unknown> | undefined
      expect(schema).toBeDefined()
      expect(schema!.type).toBe('object')
      const props = schema!.properties as Record<string, unknown>
      // The schema must declare period, period_label, rutor, summary, warnings.
      expect(props).toHaveProperty('period')
      expect(props).toHaveProperty('rutor')
      expect(props).toHaveProperty('summary')
      expect(props).toHaveProperty('warnings')
      // rutor must declare each ruta the runtime returns.
      const rutorProps = (props.rutor as { properties: Record<string, unknown> }).properties
      for (const r of ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta30', 'ruta31', 'ruta32', 'ruta35', 'ruta39', 'ruta40', 'ruta48', 'ruta49']) {
        expect(rutorProps, `tool ${name} rutor.${r}`).toHaveProperty(r)
      }
    }
  })

  it('exposes an optional qualified fiscal_period_id on every MCP VAT period tool', () => {
    for (const name of [
      'gnubok_get_vat_report',
      'gnubok_vat_review_widget',
      'gnubok_vat_close_check',
      'gnubok_vat_declaration_validate',
      'gnubok_vat_declaration_submit',
      'gnubok_vat_declaration_status',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, `tool ${name}`).toBeDefined()
      const schema = tool!.inputSchema as {
        required?: string[]
        properties?: Record<string, {
          type?: string
          format?: string
          minimum?: number
          maximum?: number
        }>
      }
      expect(schema.properties?.fiscal_period_id, name).toMatchObject({
        type: 'string',
        format: 'uuid',
      })
      expect(schema.required ?? [], name).not.toContain('fiscal_period_id')
      expect(schema.properties?.year, name).toMatchObject({
        type: 'integer',
        minimum: 2000,
        maximum: 2100,
      })
      expect(schema.properties?.period, name).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 12,
      })
    }
  })

  it('rejects bad period_type / out-of-range period / out-of-range year', async () => {
    const supabase = mockSupabaseWithLines([])

    await expect(
      computeVatReport({ period_type: 'weekly', year: 2026, period: 1 }, 'c', supabase)
    ).rejects.toThrow(/period_type/)

    await expect(
      computeVatReport({ period_type: 'monthly', year: 2026, period: 13 }, 'c', supabase)
    ).rejects.toThrow(/period must be 1-12/)

    await expect(
      computeVatReport({ period_type: 'quarterly', year: 2026, period: 5 }, 'c', supabase)
    ).rejects.toThrow(/period must be 1-4/)

    await expect(
      computeVatReport({ period_type: 'monthly', year: 1900, period: 1 }, 'c', supabase)
    ).rejects.toThrow(/year must be between/)
  })

  it.each([
    { period_type: 'monthly', year: 2026, period: 1.5 },
    { period_type: 'monthly', year: Number.NaN, period: 1 },
    { period_type: 'monthly', year: '2e3', period: 1 },
    { period_type: 'monthly', year: '2026tail', period: 1 },
    { period_type: 'yearly', year: 2026, period: 2 },
  ])('rejects non-canonical MCP VAT input before report reads: $period_type $year $period', async (args) => {
    const supabase = mockSupabaseWithLines([])
    await expect(computeVatReport(args, 'c', supabase)).rejects.toThrow()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
