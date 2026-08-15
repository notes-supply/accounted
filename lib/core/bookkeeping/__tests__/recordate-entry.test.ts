import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import {
  CannotCorrectNonPostedError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
} from '@/lib/bookkeeping/errors'

// ============================================================
// Mock: sequential results, separate client/builder (see storno-service.test)
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let inserts: Array<{ table: string; payload: unknown }>

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update', 'delete']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  b.insert = vi.fn().mockImplementation((payload: unknown) => {
    inserts.push({ table, payload })
    return b
  })
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.maybeSingle = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null }),
  }
}

vi.mock('@/lib/bookkeeping/engine', () => ({
  validateBalance: vi.fn().mockReturnValue({ valid: true, totalDebit: 1008.75, totalCredit: 1008.75 }),
  getNextVoucherNumber: vi.fn(async () => 1),
}))

// On-demand BAS backfill: never triggered here (accounts resolve on the
// first read in every scenario below).
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn(async () => []),
}))

// resolvePeriodStatusForDate is the classification gate: mock it directly so
// each test controls whether the target date is open/locked/closed/uncovered.
const mockResolve = vi.fn()
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePeriodStatusForDate: (...args: unknown[]) => mockResolve(...args),
}))

import { recordateEntry } from '../storno-service'
import { validateBalance, getNextVoucherNumber } from '@/lib/bookkeeping/engine'

const original = makeJournalEntry({
  id: 'orig-1',
  status: 'posted',
  description: 'One.com',
  entry_date: '2026-07-03',
  fiscal_period_id: 'fp-2026',
  voucher_series: 'A',
  lines: [
    makeJournalEntryLine({ account_number: '6230', debit_amount: 1008.75, credit_amount: 0 }),
    makeJournalEntryLine({ account_number: '1930', debit_amount: 0, credit_amount: 1008.75 }),
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  resultIdx = 0
  results = []
  inserts = []
  vi.mocked(validateBalance).mockReturnValue({ valid: true, totalDebit: 1008.75, totalCredit: 1008.75 })
  let v = 0
  vi.mocked(getNextVoucherNumber).mockImplementation(async () => ++v)
})

describe('recordateEntry', () => {
  it('throws no_date_change when the new date equals the current date', async () => {
    results = [{ data: original, error: null }]
    const supabase = makeClient()
    await expect(
      recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2026-07-03')
    ).rejects.toMatchObject({ code: 'MEANINGLESS_CORRECTION', reason: 'no_date_change' })
    // Classification is never reached for a no-op move.
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('rejects a non-posted entry', async () => {
    results = [{ data: { ...original, status: 'draft' }, error: null }]
    const supabase = makeClient()
    await expect(
      recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2025-07-03')
    ).rejects.toBeInstanceOf(CannotCorrectNonPostedError)
  })

  it('refuses to move into a closed fiscal year', async () => {
    results = [{ data: original, error: null }]
    mockResolve.mockResolvedValue({ status: 'closed', period_id: 'fp-2025', lock_date: null })
    const supabase = makeClient()
    await expect(
      recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2025-07-03')
    ).rejects.toBeInstanceOf(TargetPeriodClosedError)
  })

  it('refuses to move into a locked period and carries the lock date', async () => {
    results = [{ data: original, error: null }]
    mockResolve.mockResolvedValue({ status: 'locked', period_id: 'fp-2025', lock_date: '2025-12-31' })
    const supabase = makeClient()
    await expect(
      recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2025-07-03')
    ).rejects.toMatchObject({ code: 'TARGET_PERIOD_LOCKED', lockDate: '2025-12-31' })
  })

  it('refuses when no fiscal period covers the date', async () => {
    results = [{ data: original, error: null }]
    mockResolve.mockResolvedValue({ status: 'open', period_id: null, lock_date: null })
    const supabase = makeClient()
    await expect(
      recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2025-07-03')
    ).rejects.toBeInstanceOf(NoOpenPeriodForDateError)
  })

  it('moves the entry: storno in the original period, corrected in the target period with the new date', async () => {
    mockResolve.mockResolvedValue({ status: 'open', period_id: 'fp-2025', lock_date: null })
    const reversalEntry = makeJournalEntry({ id: 'reversal-1', reverses_id: 'orig-1' })
    const correctedEntry = makeJournalEntry({ id: 'corrected-1', correction_of_id: 'orig-1' })
    // recordateEntry fetches the original once and hands it to correctEntry via
    // preloadedOriginal, so there is no second original fetch in the sequence.
    results = [
      { data: original, error: null }, // 0 recordate fetch original
      {
        data: {
          id: 'orig-1',
          company_id: 'company-1',
          source_type: original.source_type,
          correction_of_id: null,
        },
        error: null,
      }, // 1 correction ancestry root
      {
        data: {
          valid: true,
          company_id: 'company-1',
          requested_root_count: 1,
          row_count: 1,
          max_depth: 0,
          max_correction_depth: 0,
          terminal_storno_depth: null,
          rows: [
            {
              root_id: 'orig-1',
              parent_id: null,
              edge_kind: 'root',
              id: 'orig-1',
              company_id: 'company-1',
              entry_date: original.entry_date,
              status: 'posted',
              source_type: original.source_type,
              correction_of_id: null,
              reverses_id: null,
              reversed_by_id: null,
              committed_at: '2026-07-03T10:00:00Z',
              depth: 0,
              path: ['orig-1'],
              cycle: false,
            },
          ],
        },
        error: null,
      }, // 2 canonical generic lineage
      { data: [], error: null }, // 3 active supplier allocations
      { data: [], error: null }, // 4 historical supplier allocations
      { data: { name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }, error: null }, // 5 target period
      { data: [{ id: 'a1', account_number: '6230' }, { id: 'a2', account_number: '1930' }], error: null }, // 6 accounts (Step 0)
      { data: reversalEntry, error: null }, // 7 insert reversal
      { data: null, error: null }, // 8 reversal lines
      { data: null, error: null }, // 9 post reversal
      { data: correctedEntry, error: null }, // 10 insert corrected
      { data: null, error: null }, // 11 corrected lines
      { data: null, error: null }, // 12 post corrected
      { data: [{ id: 'orig-1' }], error: null }, // 13 CAS
      { data: null, error: null }, // 14 relink transactions
      { data: null, error: null }, // 15 relink documents
      { data: { ...reversalEntry, lines: [] }, error: null }, // 16 final reversal
      { data: { ...correctedEntry, lines: [] }, error: null }, // 17 final corrected
    ]
    const supabase = makeClient()
    const result = await recordateEntry(supabase as never, 'company-1', 'user-1', 'orig-1', '2025-07-03')
    expect(result.corrected.id).toBe('corrected-1')

    const je = inserts
      .filter((i) => i.table === 'journal_entries')
      .map((i) => i.payload as { source_type: string; fiscal_period_id: string; entry_date: string })
    expect(je[0]).toMatchObject({ source_type: 'storno', fiscal_period_id: 'fp-2026', entry_date: '2026-07-03' })
    expect(je[1]).toMatchObject({ source_type: 'correction', fiscal_period_id: 'fp-2025', entry_date: '2025-07-03' })
    expect(mockResolve).toHaveBeenCalledWith(expect.anything(), 'company-1', '2025-07-03')
  })
})
