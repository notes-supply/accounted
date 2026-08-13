import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import type { JournalEntry } from '@/types'
import {
  BookkeepingDatabaseError,
  MeaninglessCorrectionError,
  SupplierPaymentAccountingChangeError,
} from '@/lib/bookkeeping/errors'

// ============================================================
// Mock: separate client (no .then) from query builder (thenable)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let inserts: Array<{ table: string; payload: unknown }>
let supplierPaymentLinks: Array<{ id: string; journal_entry_id: string }>
let ancestryEntries: Map<string, JournalEntry>
let correctionChildren: Array<{ id: string; correction_of_id: string; status?: string }>

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  const eqValues: Record<string, unknown> = {}
  const inValues: Record<string, unknown[]> = {}
  for (const m of ['select', 'update', 'delete', 'limit']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.eq = vi.fn().mockImplementation((column: string, value: unknown) => {
    eqValues[column] = value
    return b
  })
  b.in = vi.fn().mockImplementation((column: string, values: unknown[]) => {
    inValues[column] = values
    return b
  })
  b.insert = vi.fn().mockImplementation((payload: unknown) => {
    inserts.push({ table, payload })
    return b
  })
  b.single = vi.fn().mockImplementation(
    async () => results[resultIdx++] ?? { data: null, error: null },
  )
  b.maybeSingle = vi.fn().mockImplementation(async () => {
    const entry = ancestryEntries.get(String(eqValues.id))
    if (!entry || entry.company_id !== eqValues.company_id) {
      return { data: null, error: null }
    }
    return { data: entry, error: null }
  })
  b.then = (resolve: (v: unknown) => void) => {
    if (table === 'supplier_invoice_payments') {
      return resolve({ data: supplierPaymentLinks, error: null })
    }
    if (table === 'journal_entries' && inValues.correction_of_id) {
      return resolve({
        data: correctionChildren.filter((child) =>
          inValues.correction_of_id.includes(child.correction_of_id),
        ),
        error: null,
      })
    }
    return resolve(results[resultIdx++] ?? { data: null, error: null })
  }
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

vi.mock('@/lib/bookkeeping/engine', () => ({
  validateBalance: vi.fn().mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 }),
  getNextVoucherNumber: vi.fn(async () => ++resultIdx), // just increment
}))

// On-demand BAS backfill, default: nothing seedable. Tests override.
const mockBackfill = vi.fn()
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

import { correctEntry } from '../storno-service'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
  inserts = []
  supplierPaymentLinks = []
  ancestryEntries = new Map()
  correctionChildren = []

  // Reset the mock implementations after clearAllMocks
  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1000, totalCredit: 1000 })
  let voucherNum = 0
  vi.mocked(getNextVoucherNumber).mockImplementation(async () => ++voucherNum)
  mockBackfill.mockResolvedValue([])
})

describe('correctEntry', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Test purchase',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  const correctedLines = [
    { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1200 },
  ]

  function setupResults() {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      // 0: fetch original (.single())
      { data: originalEntry, error: null },
      // 1: fetch accounts for corrected lines: Step 0 pre-validation (thenable)
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null },
      // 2: insert reversal entry (.single())
      { data: reversalEntry, error: null },
      // 3: insert reversal lines (thenable)
      { data: null, error: null },
      // 4: update reversal to posted (thenable)
      { data: null, error: null },
      // 5: insert corrected entry (.single())
      { data: correctedEntry, error: null },
      // 6: insert corrected lines (thenable)
      { data: null, error: null },
      // 7: update corrected to posted (thenable)
      { data: null, error: null },
      // 8: CAS update original to reversed (thenable, needs array for .length check)
      { data: [{ id: 'orig-1' }], error: null },
      // 9: relink transactions original → corrected (thenable)
      { data: null, error: null },
      // 10: relink documents original → corrected (thenable)
      { data: null, error: null },
      // 11: fetch final reversal (.single())
      { data: { ...reversalEntry, lines: [] }, error: null },
      // 12: fetch final corrected (.single())
      { data: { ...correctedEntry, lines: correctedLines }, error: null },
    ]
  }

  it('creates reversal with swapped debit/credit lines', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal).toBeDefined()
    expect(result.reversal.reverses_id).toBe('orig-1')
  })

  it('links original ↔ reversal ↔ corrected via IDs', async () => {
    setupResults()
    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    expect(result.reversal.id).toBe('reversal-1')
    expect(result.corrected.id).toBe('corrected-1')
    expect(result.corrected.correction_of_id).toBe('orig-1')
  })

  it('validates balance of corrected lines (rejects unbalanced)', async () => {
    vi.mocked(validateBalance).mockReturnValueOnce({
      valid: false,
      totalDebit: 1200,
      totalCredit: 1000,
    })

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', [
        { account_number: '5420', debit_amount: 1200, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
      ])
    ).rejects.toThrow('not balanced')
  })

  it('rejects economic line changes for a supplier-payment-linked entry before mutation', async () => {
    const linkedOriginal = makeJournalEntry({
      ...originalEntry,
      lines: [
        makeJournalEntryLine({
          account_number: '2440',
          debit_amount: 500,
          credit_amount: 0,
        }),
        makeJournalEntryLine({
          account_number: '1930',
          debit_amount: 0,
          credit_amount: 500,
        }),
      ],
    })
    vi.mocked(validateBalance).mockReturnValue({
      valid: true,
      totalDebit: 300,
      totalCredit: 300,
    })
    supplierPaymentLinks = [{
      id: 'supplier-payment-1',
      journal_entry_id: 'orig-1',
    }]
    results = [{ data: linkedOriginal, error: null }]
    const supabase = makeClient()

    const error = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      [
        { account_number: '2440', debit_amount: 300, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 300 },
      ],
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SupplierPaymentAccountingChangeError)
    expect(error).toMatchObject({
      code: 'SUPPLIER_PAYMENT_ACCOUNTING_CHANGE_FORBIDDEN',
      message:
        'A journal entry linked to supplier payment history can only be corrected'
        + ' with economically identical accounting lines',
    })

    expect(inserts).toEqual([])
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual([
      'journal_entries',
      'journal_entries',
      'supplier_invoice_payments',
    ])
  })

  it('rejects economic line changes for allocation-free typed supplier payments', async () => {
    const typedPayment = makeJournalEntry({
      ...originalEntry,
      source_type: 'supplier_invoice_paid',
      source_id: 'supplier-invoice-1',
      lines: [
        makeJournalEntryLine({ account_number: '2440', debit_amount: 500, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 500 }),
      ],
    })
    vi.mocked(validateBalance).mockReturnValue({
      valid: true,
      totalDebit: 300,
      totalCredit: 300,
    })
    results = [{ data: typedPayment, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', typedPayment.id, [
        { account_number: '2440', debit_amount: 300, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 300 },
      ]),
    ).rejects.toBeInstanceOf(SupplierPaymentAccountingChangeError)

    expect(inserts).toEqual([])
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('rejects an economic correction after a date-only correction of an allocated root', async () => {
    const paymentLines = [
      makeJournalEntryLine({ account_number: '2440', debit_amount: 500, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 500 }),
    ]
    const paymentRoot = makeJournalEntry({
      id: 'payment-root',
      status: 'reversed',
      source_type: 'supplier_invoice_paid',
      entry_date: '2026-01-15',
      lines: paymentLines,
    })
    const dateCorrection = makeJournalEntry({
      id: 'date-correction',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: paymentRoot.id,
      entry_date: '2026-01-20',
      lines: paymentLines,
    })
    ancestryEntries.set(paymentRoot.id, paymentRoot)
    correctionChildren = [{ id: dateCorrection.id, correction_of_id: paymentRoot.id }]
    supplierPaymentLinks = [{
      id: 'supplier-payment-1',
      journal_entry_id: paymentRoot.id,
    }]
    results = [{ data: dateCorrection, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', dateCorrection.id, [
        { account_number: '2440', debit_amount: 300, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 300 },
      ]),
    ).rejects.toBeInstanceOf(SupplierPaymentAccountingChangeError)

    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('allows a second date-only correction on the live chain of an allocated root', async () => {
    const paymentLines = [
      makeJournalEntryLine({ account_number: '2440', debit_amount: 500, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 500 }),
    ]
    const paymentRoot = makeJournalEntry({
      id: 'payment-root',
      status: 'reversed',
      source_type: 'supplier_invoice_paid',
      entry_date: '2026-01-15',
      fiscal_period_id: 'fp-1',
      lines: paymentLines,
    })
    const dateCorrection = makeJournalEntry({
      id: 'date-correction',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: paymentRoot.id,
      entry_date: '2026-01-20',
      fiscal_period_id: 'fp-1',
      lines: paymentLines,
    })
    const reversalEntry = makeJournalEntry({
      id: 'reversal-2',
      reverses_id: dateCorrection.id,
    })
    const correctedEntry = makeJournalEntry({
      id: 'date-correction-2',
      source_type: 'correction',
      correction_of_id: dateCorrection.id,
      entry_date: '2026-01-25',
    })
    ancestryEntries.set(paymentRoot.id, paymentRoot)
    correctionChildren = [{ id: dateCorrection.id, correction_of_id: paymentRoot.id }]
    supplierPaymentLinks = [{
      id: 'supplier-payment-1',
      journal_entry_id: paymentRoot.id,
    }]
    results = [
      { data: dateCorrection, error: null },
      {
        data: {
          name: '2026',
          period_start: '2026-01-01',
          period_end: '2026-12-31',
        },
        error: null,
      },
      {
        data: [
          { id: 'acc-2440', account_number: '2440' },
          { id: 'acc-1930', account_number: '1930' },
        ],
        error: null,
      },
      { data: reversalEntry, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: correctedEntry, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: [{ id: dateCorrection.id }], error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { ...reversalEntry, lines: [] }, error: null },
      { data: { ...correctedEntry, lines: paymentLines }, error: null },
    ]
    const supabase = makeClient()

    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      dateCorrection.id,
      paymentLines.map((line) => ({
        account_number: line.account_number,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
      })),
      { newEntryDate: '2026-01-25' },
    )

    expect(result.corrected.id).toBe('date-correction-2')
    const entryInserts = inserts.filter(({ table }) => table === 'journal_entries')
    expect(entryInserts[1].payload).toMatchObject({
      correction_of_id: dateCorrection.id,
      entry_date: '2026-01-25',
    })
    expect(getNextVoucherNumber).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing ancestor', new Map<string, JournalEntry>()],
    ['cross-company ancestor', new Map<string, JournalEntry>([
      ['payment-root', makeJournalEntry({
        id: 'payment-root',
        company_id: 'company-2',
        status: 'reversed',
      })],
    ])],
  ])('fails closed on a %s before correction mutation', async (_case, ancestors) => {
    const correction = makeJournalEntry({
      id: 'date-correction',
      source_type: 'correction',
      correction_of_id: 'payment-root',
      lines: originalEntry.lines,
    })
    ancestryEntries = ancestors
    results = [{ data: correction, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', correction.id, correctedLines),
    ).rejects.toThrow('Could not verify supplier payment correction ancestry')
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('fails closed on cyclic correction ancestry before correction mutation', async () => {
    const first = makeJournalEntry({
      id: 'correction-1',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'correction-2',
      lines: originalEntry.lines,
    })
    const second = makeJournalEntry({
      id: 'correction-2',
      status: 'reversed',
      source_type: 'correction',
      correction_of_id: first.id,
      lines: originalEntry.lines,
    })
    ancestryEntries.set(first.id, first)
    ancestryEntries.set(second.id, second)
    results = [{ data: first, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', first.id, correctedLines),
    ).rejects.toThrow('cyclic lineage')
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('fails closed on ambiguous correction ancestry before correction mutation', async () => {
    const root = makeJournalEntry({
      id: 'payment-root',
      status: 'reversed',
      lines: originalEntry.lines,
    })
    const correction = makeJournalEntry({
      id: 'date-correction',
      source_type: 'correction',
      correction_of_id: root.id,
      lines: originalEntry.lines,
    })
    ancestryEntries.set(root.id, root)
    correctionChildren = [
      { id: correction.id, correction_of_id: root.id },
      { id: 'sibling-correction', correction_of_id: root.id },
    ]
    results = [{ data: correction, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', correction.id, correctedLines),
    ).rejects.toThrow('ambiguous lineage')
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('rejects correcting a root that already has a posted correction child', async () => {
    correctionChildren = [{
      id: 'existing-posted-correction',
      correction_of_id: originalEntry.id,
      status: 'posted',
    }]
    results = [{ data: originalEntry, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', originalEntry.id, correctedLines),
    ).rejects.toThrow(`ambiguous lineage at entry ${originalEntry.id}`)

    expect(mockBackfill).not.toHaveBeenCalled()
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('rejects correcting a chained leaf that already has a posted correction child', async () => {
    const root = makeJournalEntry({
      id: 'correction-root',
      status: 'reversed',
      lines: originalEntry.lines,
    })
    const requested = makeJournalEntry({
      id: 'requested-correction',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: root.id,
      lines: originalEntry.lines,
    })
    ancestryEntries.set(root.id, root)
    correctionChildren = [
      { id: requested.id, correction_of_id: root.id, status: 'reversed' },
      {
        id: 'existing-posted-leaf-child',
        correction_of_id: requested.id,
        status: 'posted',
      },
    ]
    results = [{ data: requested, error: null }]
    const supabase = makeClient()

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', requested.id, correctedLines),
    ).rejects.toThrow(`ambiguous lineage at entry ${requested.id}`)

    expect(mockBackfill).not.toHaveBeenCalled()
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
    expect(inserts).toEqual([])
  })

  it('cancels both entries on concurrent reversal (CAS guard)', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },         // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },          // 2: insert reversal
      { data: null, error: null },                   // 3: insert reversal lines
      { data: null, error: null },                   // 4: post reversal
      { data: correctedEntry, error: null },         // 5: insert corrected
      { data: null, error: null },                   // 6: insert corrected lines
      { data: null, error: null },                   // 7: post corrected
      { data: [], error: null },                     // 8: CAS fails: empty array
      { data: null, error: null },                   // 9: cancelEntry reversal update
      { data: null, error: null },                   // 10: cancelEntry reversal lines delete
      { data: null, error: null },                   // 11: cancelEntry corrected update
      { data: null, error: null },                   // 12: cancelEntry corrected lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow('already reversed')
  })

  it('cancels reversal when corrected entry creation fails', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },          // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },           // 2: insert reversal
      { data: null, error: null },                    // 3: insert reversal lines
      { data: null, error: null },                    // 4: post reversal
      { data: null, error: { message: 'DB error' } }, // 5: insert corrected FAILS
      { data: null, error: null },                    // 6: cancelEntry reversal update
      { data: null, error: null },                    // 7: cancelEntry reversal lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('cancels reversal entry when reversal lines fail', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })

    results = [
      { data: originalEntry, error: null },           // 0: fetch original
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: reversalEntry, error: null },            // 2: insert reversal
      { data: null, error: { message: 'line error' } }, // 3: insert reversal lines FAILS
      { data: null, error: null },                     // 4: cancelEntry update
      { data: null, error: null },                     // 5: cancelEntry lines delete
    ]

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  it('mirrors original.entry_date on storno + corrected entries (rättelsen stannar i ursprungsperioden)', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const journalEntryInserts = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { entry_date: string; source_type: string })

    expect(journalEntryInserts).toHaveLength(2)
    expect(journalEntryInserts[0]).toMatchObject({ source_type: 'storno', entry_date: '2024-06-15' })
    expect(journalEntryInserts[1]).toMatchObject({ source_type: 'correction', entry_date: '2024-06-15' })
  })

  it('rejects rättelse where every account nets to zero (1930 → 1930)', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toBeInstanceOf(MeaninglessCorrectionError)

    // Guard runs before any DB call: original must not be fetched.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects rättelse where multiple accounts each net to zero', async () => {
    const supabase = makeClient()
    const noOpLines = [
      { account_number: '1930', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
      { account_number: '5410', debit_amount: 50, credit_amount: 0 },
      { account_number: '5410', debit_amount: 0, credit_amount: 50 },
    ]
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', noOpLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'net_zero_per_account',
    })
  })

  it('rejects rättelse identical to the original entry', async () => {
    const supabase = makeClient()
    // Only the fetch-original result is needed: guard runs right after.
    results = [{ data: originalEntry, error: null }]

    const identicalLines = [
      { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ]

    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines)
    ).rejects.toMatchObject({
      code: 'MEANINGLESS_CORRECTION',
      reason: 'identical_to_original',
    })
  })

  it('allows rättelse that shifts amounts between different accounts', async () => {
    setupResults()
    const supabase = makeClient()
    // correctedLines moves expense from 5410 → 5420, net effect per account
    // is non-zero (5420 +1200, 5410 0 since absent, 1930 -1200), and the lines
    // differ from the original, so both guards must pass.
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      correctedLines
    )
    expect(result.corrected).toBeDefined()
  })

  it('uses a caller-supplied description for the corrected entry (issue #1031)', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      description: 'Rättelse: Skulder till närstående personer, kortfristig del',
    })

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    expect(entryInserts).toHaveLength(2)
    const corrected = entryInserts[1].payload as { source_type: string; description: string }
    expect(corrected.source_type).toBe('correction')
    expect(corrected.description).toBe('Rättelse: Skulder till närstående personer, kortfristig del')
  })

  it('falls back to "Rättelse: <original>" when no description is supplied', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    const corrected = entryInserts[1].payload as { source_type: string; description: string }
    expect(corrected.source_type).toBe('correction')
    expect(corrected.description).toBe('Rättelse: Test purchase')
  })

  it('falls back to the auto text when the supplied description is blank', async () => {
    setupResults()
    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines, {
      description: '   ',
    })

    const entryInserts = inserts.filter((i) => i.table === 'journal_entries')
    const corrected = entryInserts[1].payload as { description: string }
    expect(corrected.description).toBe('Rättelse: Test purchase')
  })

  it('accepts a source_type=correction entry as the original (chained correction, BFL 5 kap. 5 §)', async () => {
    // The user just corrected entry A and got correction C. They now want to
    // correct C. A valid company-scoped ancestry with no supplier allocations
    // remains correctable.
    const correctionAsOriginal = makeJournalEntry({
      id: 'correction-1',
      status: 'posted',
      source_type: 'correction',
      correction_of_id: 'orig-A',
      description: 'Rättelse: Test purchase',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      lines: [
        makeJournalEntryLine({ account_number: '5420', debit_amount: 1200, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1200 }),
      ],
    })
    const correctionRoot = makeJournalEntry({
      id: 'orig-A',
      status: 'reversed',
      lines: [
        makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
        makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
      ],
    })
    ancestryEntries.set(correctionRoot.id, correctionRoot)
    correctionChildren = [{ id: 'correction-1', correction_of_id: 'orig-A' }]
    const secondReversal = makeJournalEntry({ id: 'reversal-2', reverses_id: 'correction-1' })
    const secondCorrection = makeJournalEntry({
      id: 'correction-2',
      correction_of_id: 'correction-1',
      source_type: 'correction',
    })

    results = [
      { data: correctionAsOriginal, error: null },                            // 0: fetch original (the prior correction)
      { data: [{ id: 'acc-5430', account_number: '5430' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts (Step 0)
      { data: secondReversal, error: null },                                  // 2: insert reversal
      { data: null, error: null },                                            // 3: insert reversal lines
      { data: null, error: null },                                            // 4: post reversal
      { data: secondCorrection, error: null },                                // 5: insert corrected
      { data: null, error: null },                                            // 6: insert corrected lines
      { data: null, error: null },                                            // 7: post corrected
      { data: [{ id: 'correction-1' }], error: null },                        // 8: CAS update
      { data: null, error: null },                                            // 9: relink transactions
      { data: null, error: null },                                            // 10: relink documents
      { data: { ...secondReversal, lines: [] }, error: null },                // 11: fetch final reversal
      { data: { ...secondCorrection, lines: [] }, error: null },              // 12: fetch final corrected
    ]

    const supabase = makeClient()
    const result = await correctEntry(supabase as never, 'company-1', 'user-1', 'correction-1', [
      { account_number: '5430', debit_amount: 1500, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1500 },
    ])

    expect(result.reversal.reverses_id).toBe('correction-1')
    expect(result.corrected.correction_of_id).toBe('correction-1')
    expect(result.corrected.source_type).toBe('correction')
  })

  it('fails fast on unknown accounts: BEFORE the storno exists or a voucher number is consumed', async () => {
    // Regression: the old flow created+posted the storno first, then hit
    // AccountsNotInChartError on the corrected lines and had to cancel the
    // storno again, leaving a voided 0 kr storno in the chain (the user's
    // "A98") and burning voucher numbers (the missing "A99").
    results = [
      { data: originalEntry, error: null }, // 0: fetch original
      { data: [{ id: 'acc-1930', account_number: '1930' }], error: null }, // 1: accounts: 5420 missing
    ]
    mockBackfill.mockResolvedValue([]) // not seedable (e.g. deactivated / unknown)

    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)
    ).rejects.toMatchObject({ code: 'ACCOUNTS_NOT_IN_CHART' })

    // Nothing was written to the journal and no voucher number was fetched.
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
    expect(inserts.filter((i) => i.table === 'journal_entry_lines')).toHaveLength(0)
    expect(getNextVoucherNumber).not.toHaveBeenCalled()
  })

  it('seeds a standard BAS account missing from the chart and proceeds', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    results = [
      { data: originalEntry, error: null },                                  // 0: fetch original
      { data: [{ id: 'acc-1930', account_number: '1930' }], error: null },   // 1: accounts: 5420 missing
      // -- backfill seeds 5420 --
      { data: [{ id: 'acc-5420', account_number: '5420' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 2: re-resolve
      { data: reversalEntry, error: null },                                  // 3: insert reversal
      { data: null, error: null },                                           // 4: reversal lines
      { data: null, error: null },                                           // 5: post reversal
      { data: correctedEntry, error: null },                                 // 6: insert corrected
      { data: null, error: null },                                           // 7: corrected lines
      { data: null, error: null },                                           // 8: post corrected
      { data: [{ id: 'orig-1' }], error: null },                             // 9: CAS
      { data: null, error: null },                                           // 10: relink transactions
      { data: null, error: null },                                           // 11: relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },                // 12: final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },               // 13: final corrected
    ]
    mockBackfill.mockResolvedValue(['5420'])

    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines
    )
    expect(result.corrected.id).toBe('corrected-1')
    expect(mockBackfill).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ['5420'])
  })

  it('emits journal_entry.corrected event', async () => {
    setupResults()

    const handler = vi.fn()
    eventBus.on('journal_entry.corrected', handler)

    const supabase = makeClient()
    await correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', correctedLines)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', companyId: 'company-1' })
    )
  })
})

describe('correctEntry: date/period override (recordate engine)', () => {
  const originalEntry = makeJournalEntry({
    id: 'orig-1',
    status: 'posted',
    description: 'Webbhotell',
    entry_date: '2024-06-15',
    fiscal_period_id: 'fp-1',
    voucher_series: 'A',
    lines: [
      makeJournalEntryLine({ account_number: '5410', debit_amount: 1000, credit_amount: 0 }),
      makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1000 }),
    ],
  })

  // Same multiset as the original: allowed here because the *date* is the
  // change (a wrong-year fix keeps the lines untouched).
  const identicalLines = [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
  ]

  it('re-books the corrected entry in the target period/date while the storno stays in the original period', async () => {
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null },  // 1 target period
      { data: [{ id: 'acc-5410', account_number: '5410' }, { id: 'acc-1930', account_number: '1930' }], error: null }, // 2 accounts (Step 0)
      { data: reversalEntry, error: null },                                                          // 3 insert reversal
      { data: null, error: null },                                                                   // 4 reversal lines
      { data: null, error: null },                                                                   // 5 post reversal
      { data: correctedEntry, error: null },                                                         // 6 insert corrected
      { data: null, error: null },                                                                   // 7 corrected lines
      { data: null, error: null },                                                                   // 8 post corrected
      { data: [{ id: 'orig-1' }], error: null },                                                     // 9 CAS
      { data: null, error: null },                                                                   // 10 relink transactions
      { data: null, error: null },                                                                   // 11 relink documents
      { data: { ...reversalEntry, lines: [] }, error: null },                                        // 12 final reversal
      { data: { ...correctedEntry, lines: [] }, error: null },                                       // 13 final corrected
    ]
    const supabase = makeClient()
    const result = await correctEntry(
      supabase as never,
      'company-1',
      'user-1',
      'orig-1',
      identicalLines,
      { newEntryDate: '2025-06-15', newFiscalPeriodId: 'fp-2' }
    )
    expect(result.corrected).toBeDefined()

    const je = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { source_type: string; fiscal_period_id: string; entry_date: string })
    expect(je).toHaveLength(2)
    expect(je[0]).toMatchObject({ source_type: 'storno', fiscal_period_id: 'fp-1', entry_date: '2024-06-15' })
    expect(je[1]).toMatchObject({ source_type: 'correction', fiscal_period_id: 'fp-2', entry_date: '2025-06-15' })
  })

  it('rejects when the new date falls outside the target period bounds', async () => {
    results = [
      { data: originalEntry, error: null },                                                          // 0 fetch original
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-05-31' }, error: null },  // 1 target period: 06-15 out of bounds
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' })

    // No storno should have been written.
    expect(inserts.filter((i) => i.table === 'journal_entries')).toHaveLength(0)
  })

  it('rejects when the target period cannot be found', async () => {
    results = [
      { data: originalEntry, error: null },           // 0 fetch original
      { data: null, error: { message: 'no rows' } },  // 1 target period missing
    ]
    const supabase = makeClient()
    await expect(
      correctEntry(supabase as never, 'company-1', 'user-1', 'orig-1', identicalLines, {
        newEntryDate: '2025-06-15',
        newFiscalPeriodId: 'fp-2',
      })
    ).rejects.toMatchObject({ code: 'FISCAL_PERIOD_NOT_FOUND' })
  })
})
