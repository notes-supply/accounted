import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let calls: Array<{ method: string; args: unknown[] }>

let lineageRows: Array<Record<string, unknown>>
function makeBuilder(_table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['eq', 'in', 'lte', 'order', 'range']) {
    b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args })
      return b
    })
  }
  b.select = vi.fn().mockImplementation((...args: unknown[]) => {
    calls.push({ method: 'select', args })
    return b
  })
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) =>
    resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async (
      _name: string,
      args: { p_root_ids: string[] },
    ) => {
      const rows = lineageRows.filter((row) =>
        args.p_root_ids.includes(row.root_id as string),
      )
      const stornoDepths = rows
        .filter((row) => row.edge_kind === 'storno')
        .map((row) => row.depth as number)
      return {
        data: {
          valid: true,
          company_id: 'company-1',
          requested_root_count: args.p_root_ids.length,
          row_count: rows.length,
          max_depth: Math.max(...rows.map((row) => row.depth as number)),
          max_correction_depth: Math.max(
            ...rows
              .filter((row) => row.edge_kind !== 'storno')
              .map((row) => row.depth as number),
          ),
          terminal_storno_depth: stornoDepths.length > 0
            ? Math.max(...stornoDepths)
            : null,
          rows,
        },
        error: null,
      }
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateReconciliation } from '../supplier-reconciliation'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  lineageRows = []
  supabase = makeClient()
})

describe('generateReconciliation', () => {
  it('returns reconciled when supplier total matches account 2440 balance', async () => {
    results = [
      // 0: supplier_invoices
      {
        data: [
          { remaining_amount: 5000 },
          { remaining_amount: 3000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines for account 2440
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 10000, journal_entry_id: 'e1' },
          { debit_amount: 2000, credit_amount: 0, journal_entry_id: 'e2' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Supplier total: 5000 + 3000 = 8000
    expect(result.supplier_ledger_total).toBe(8000)
    // Account 2440 (credit-normal): credits - debits = 10000 - 2000 = 8000
    expect(result.account_2440_balance).toBe(8000)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('paginates the 2440 ledger query: sums >1000 lines instead of truncating at 1000', async () => {
    // Regression guard for the silent PostgREST 1000-row cap: fetchAllRows must
    // page through ALL ledger lines. A full first page (length === PAGE_SIZE)
    // forces a second fetch.
    // Unique ids so the dedupe-by-id safety net doesn't collapse rows.
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}`, debit_amount: 0, credit_amount: 10 }))
    const page2 = Array.from({ length: 500 }, (_, i) => ({ id: `p2-${i}`, debit_amount: 0, credit_amount: 10 }))
    results = [
      { data: [], error: null },     // 0: supplier_invoices, none open
      // 1: journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      { data: page1, error: null },  // 2: 2440 lines page 1 (full → triggers next page)
      { data: page2, error: null },  // 3: 2440 lines page 2 (partial → stop)
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // 1500 lines × 10 = 15 000. A 1000-row truncation would wrongly yield 10 000.
    expect(result.account_2440_balance).toBe(15000)
  })

  it('detects mismatch when difference != 0', async () => {
    results = [
      // 0: supplier_invoices, total 5000
      {
        data: [
          { remaining_amount: 5000 },
        ],
        error: null,
      },
      // 1: journal_entry_lines, balance 7000
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 7000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(5000)
    expect(result.account_2440_balance).toBe(7000)
    expect(result.difference).toBe(-2000)
    expect(result.is_reconciled).toBe(false)
  })

  it('returns reconciled when both are zero/empty', async () => {
    results = [
      { data: [], error: null },
      { data: [], error: null },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('handles null invoice data gracefully', async () => {
    results = [
      { data: null, error: null },
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 3000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(3000)
    expect(result.difference).toBe(-3000)
    expect(result.is_reconciled).toBe(false)
  })

  it('computes credit-normal balance for account 2440 (liability)', async () => {
    results = [
      { data: [], error: null },
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 15000, journal_entry_id: 'e1' },
          { debit_amount: 5000, credit_amount: 0, journal_entry_id: 'e2' },
          { debit_amount: 3000, credit_amount: 0, journal_entry_id: 'e3' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    // Balance = credits - debits = 15000 - 5000 - 3000 = 7000
    expect(result.account_2440_balance).toBe(7000)
  })

  it('converts foreign-currency remaining_amount to SEK before reconciliation', async () => {
    // Reproduces the production bug: 225 EUR + 1 000 SEK was reported as 1 225
    // against a 2440 balance of 3 475, flagging a false discrepancy.
    results = [
      // 0: supplier_invoices, 225 EUR at 11, plus 1 000 SEK
      {
        data: [
          { remaining_amount: 225, currency: 'EUR', exchange_rate: 11 },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance = 3 475 SEK (matches converted ledger total)
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 3475, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(3475)
    expect(result.account_2440_balance).toBe(3475)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
    expect(result.unconverted_fx_count).toBe(0)
  })

  it('excludes FX invoices without exchange_rate from the SEK total and counts them', async () => {
    // An FX invoice without an exchange rate cannot be converted to SEK; the
    // sum must not silently add raw foreign currency. The row is excluded and
    // counted, so the UI can warn that the reconciliation may be unreliable.
    results = [
      // 0: supplier_invoices, 100 EUR with no rate (excluded), 1 000 SEK control
      {
        data: [
          { remaining_amount: 100, currency: 'EUR', exchange_rate: null },
          { remaining_amount: 1000, currency: 'SEK', exchange_rate: null },
        ],
        error: null,
      },
      // 1: 2440 balance reflects only the SEK invoice
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 1000, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.unconverted_fx_count).toBe(1)
    // EUR row excluded → ledger total is just the SEK 1 000
    expect(result.supplier_ledger_total).toBe(1000)
    expect(result.account_2440_balance).toBe(1000)
    // Numbers match, but the calculation is incomplete (a row was excluded);
    // BFL 5 kap requires the period not be stamped Avstämd until the missing
    // exchange rate is filled in.
    expect(result.is_reconciled).toBe(false)
  })

  it('counts posted AND reversed 2440 lines (corrected invoice nets correctly)', async () => {
    // Regression for the Arcim Technology AB false "Ej avstämd" gap: two supplier
    // invoices were registered, corrected via the storno flow, and fully paid.
    // The corrected registrations flip to status='reversed'. The leverantörs-
    // reskontra shows 0 outstanding, and over posted+reversed the 2440 balance is
    // 0 too, but a posted-only query saw only the storno + correction + payment
    // legs and reported a phantom −41 121,25 kr debit. The query must include the
    // reversed registration leg so both reconcile.
    results = [
      // 0: supplier_invoices, both paid, nothing outstanding
      { data: [], error: null },
      // 1: 2440 lines as returned by the posted+reversed query for one corrected,
      //    paid invoice of 11 231,25: registration (reversed credit), storno
      //    (debit), correction (credit), payment (debit). Net credit−debit = 0.
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 11231.25, journal_entry_id: 'reg-reversed' },
          { debit_amount: 11231.25, credit_amount: 0, journal_entry_id: 'storno' },
          { debit_amount: 0, credit_amount: 11231.25, journal_entry_id: 'correction' },
          { debit_amount: 11231.25, credit_amount: 0, journal_entry_id: 'payment' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(0)
    expect(result.account_2440_balance).toBe(0)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)

    // Guard the actual fix: the 2440 query must include reversed entries, not
    // filter to posted-only (which excluded the reversed registration leg).
    // The status filter now lives on the journal_entries query itself (the
    // two-step entry-lines fetch), not on an embedded-side column. The open
    // invoices query also filters .in('status', ...), so assert that ONE of
    // the status filters is the posted+reversed ledger inclusion rule.
    const statusFilters = calls.filter(
      (c) => c.method === 'in' && c.args[0] === 'status',
    )
    expect(statusFilters.map((c) => c.args[1])).toContainEqual(['posted', 'reversed'])
  })

  it('uses Math.round for monetary precision', async () => {
    results = [
      {
        data: [
          { remaining_amount: 33.33 },
          { remaining_amount: 33.34 },
        ],
        error: null,
      },
      // journal_entries page for the two-step entry-lines fetch
      { data: [{ id: 'entry-1' }], error: null },
      {
        data: [
          { debit_amount: 0, credit_amount: 66.67, journal_entry_id: 'e1' },
        ],
        error: null,
      },
    ]

    const result = await generateReconciliation(supabase, 'company-1', 'period-1')

    expect(result.supplier_ledger_total).toBe(66.67)
    expect(result.account_2440_balance).toBe(66.67)
    expect(result.difference).toBe(0)
    expect(result.is_reconciled).toBe(true)
  })

  it('reconstructs signed supplier credits and payments at the supplied cutoff', async () => {
    results = [
      {
        data: [
          {
            id: 'si-original', total: 1000, remaining_amount: 0, paid_at: '2027-01-10',
            currency: 'SEK', exchange_rate: null, is_credit_note: false,
            registration_journal_entry_id: 'reg-original',
          },
          {
            id: 'si-credit', total: 250, remaining_amount: 250, paid_at: null,
            currency: 'SEK', exchange_rate: null, is_credit_note: true,
            registration_journal_entry_id: 'reg-credit',
          },
        ],
        error: null,
      },
      {
        data: [{
          id: 'pay-later', supplier_invoice_id: 'si-original', amount: 1000,
          payment_date: '2027-01-10', journal_entry_id: null,
        }],
        error: null,
      },
      { data: [], error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: [{ debit_amount: 0, credit_amount: 750, journal_entry_id: 'entry-1' }], error: null },
    ]
    lineageRows = ['reg-original', 'reg-credit'].map((id) => ({
      root_id: id,
      parent_id: null,
      edge_kind: 'root',
      id,
      company_id: 'company-1',
      entry_date: '2026-12-01',
      status: 'posted',
      source_type: 'supplier_invoice_received',
      correction_of_id: null,
      reverses_id: null,
      reversed_by_id: null,
      committed_at: '2026-12-01T10:00:00Z',
      depth: 0,
      path: [id],
      cycle: false,
    }))

    const result = await generateReconciliation(
      supabase,
      'company-1',
      'period-1',
      '2026-12-31',
    )
    expect(result.supplier_ledger_total).toBe(750)
    expect(result.is_reconciled).toBe(true)
    const statusFilters = calls.filter(
      (call) => call.method === 'in' && call.args[0] === 'status',
    )
    expect(statusFilters.map((call) => call.args[1])).toEqual([['posted', 'reversed']])
  })
})
