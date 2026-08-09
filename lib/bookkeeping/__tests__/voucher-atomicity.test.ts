import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JournalEntryStatus } from '@/types'

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

import { commitEntry, getNextVoucherNumber, createJournalEntry } from '../engine'
import { runWithActor } from '../actor-context-node'
import { BookkeepingDatabaseError } from '../errors'
import { eventBus } from '@/lib/events'

type AmbiguousRpcOutcome =
  | { kind: 'returned'; message: string }
  | { kind: 'thrown'; message: string }

function makeAmbiguousCommitSupabase(
  rpcOutcome: AmbiguousRpcOutcome,
  readback: { data: unknown; error: unknown },
) {
  const readbackMaybeSingle = vi.fn().mockResolvedValue(readback)
  const companyEq = vi.fn().mockReturnValue({ maybeSingle: readbackMaybeSingle })
  const entryEq = vi.fn().mockReturnValue({ eq: companyEq })
  const readbackSelect = vi.fn().mockReturnValue({ eq: entryEq })
  const rulesQuery = Promise.resolve({ data: [], error: null })
  const rulesSecondEq = vi.fn().mockReturnValue(rulesQuery)
  const rulesFirstEq = vi.fn().mockReturnValue({ eq: rulesSecondEq })
  const rulesSelect = vi.fn().mockReturnValue({ eq: rulesFirstEq })
  const rpc = rpcOutcome.kind === 'returned'
    ? vi.fn().mockResolvedValue({ data: null, error: { message: rpcOutcome.message } })
    : vi.fn().mockRejectedValue(new TypeError(rpcOutcome.message))

  return {
    supabase: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'account_dimension_rules') return { select: rulesSelect }
        if (table === 'journal_entries') return { select: readbackSelect }
        throw new Error(`Unexpected table: ${table}`)
      }),
      rpc,
    },
    entryEq,
    companyEq,
    readbackMaybeSingle,
  }
}

describe('voucher number atomicity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getNextVoucherNumber returns incrementing numbers from RPC', async () => {
    let callCount = 0
    const supabase = {
      rpc: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({ data: callCount, error: null })
      }),
    }

    const n1 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    const n2 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    const n3 = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')

    expect(n1).toBe(1)
    expect(n2).toBe(2)
    expect(n3).toBe(3)
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
  })

  it('getNextVoucherNumber throws on RPC error', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection lost' } }),
    }

    await expect(
      getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'A')
    ).rejects.toThrow(BookkeepingDatabaseError)
  })

  /**
   * commitEntry uses the atomic commit_journal_entry RPC which increments the
   * voucher sequence and updates the entry status in one transaction.
   * If the RPC fails (e.g., balance trigger rejection), the sequence increment
   * rolls back: no burned number, no gap.
   */
  it('commitEntry RPC failure stays ordinary only after company-scoped draft readback', async () => {
    const { supabase, entryEq, companyEq } = makeAmbiguousCommitSupabase(
      { kind: 'returned', message: 'Journal entry is not balanced: debit=1000 credit=500' },
      { data: { status: 'draft', voucher_number: 0 }, error: null },
    )

    await expect(
      commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')
    ).rejects.toThrow(BookkeepingDatabaseError)

    // The atomic RPC was called: it failed, rolling back both the
    // sequence increment and the status update. No burned number.
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: null,
      p_rubric_version: null,
      p_actor_type: null,
      p_actor_label: null,
    })

    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
    expect(supabase.from).not.toHaveBeenCalledWith('journal_entry_lines')
    expect(entryEq).toHaveBeenCalledWith('id', 'entry-1')
    expect(companyEq).toHaveBeenCalledWith('company_id', 'co-1')
  })

  it.each([
    { rpcKind: 'returned' as const, readbackKind: 'posted' as const },
    { rpcKind: 'returned' as const, readbackKind: 'error' as const },
    { rpcKind: 'returned' as const, readbackKind: 'missing' as const },
    { rpcKind: 'thrown' as const, readbackKind: 'posted' as const },
    { rpcKind: 'thrown' as const, readbackKind: 'error' as const },
    { rpcKind: 'thrown' as const, readbackKind: 'missing' as const },
  ])(
    'commitEntry classifies $rpcKind RPC failure with $readbackKind readback as unknown-post',
    async ({ rpcKind, readbackKind }) => {
      const readback = readbackKind === 'posted'
        ? { data: { status: 'posted', voucher_number: 73 }, error: null }
        : readbackKind === 'error'
          ? { data: null, error: { message: 'readback transport failed', code: '08006' } }
          : { data: null, error: null }
      const { supabase, entryEq, companyEq } = makeAmbiguousCommitSupabase(
        { kind: rpcKind, message: 'commit transport failed' },
        readback,
      )

      await expect(
        commitEntry(supabase as never, 'co-1', 'user-1', 'entry-ambiguous'),
      ).rejects.toMatchObject({
        name: 'PostCommitReadbackError',
        journalEntryId: 'entry-ambiguous',
        voucherNumber: readbackKind === 'posted' ? 73 : null,
      })
      expect(entryEq).toHaveBeenCalledWith('id', 'entry-ambiguous')
      expect(companyEq).toHaveBeenCalledWith('company_id', 'co-1')
    },
  )

  it.each([
    { kind: 'returned' as const, message: 'constraint rejected commit' },
    { kind: 'thrown' as const, message: 'fetch failed' },
  ])(
    'commitEntry keeps a $kind RPC failure ordinary when readback proves draft',
    async (rpcOutcome) => {
      const { supabase } = makeAmbiguousCommitSupabase(
        rpcOutcome,
        { data: { status: 'draft', voucher_number: 0 }, error: null },
      )

      await expect(
        commitEntry(supabase as never, 'co-1', 'user-1', 'entry-draft'),
      ).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    },
  )

  it('commitEntry succeeds via atomic RPC and returns posted entry', async () => {
    const postedEntry = {
      id: 'entry-1',
      company_id: 'co-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      voucher_number: 3,
      status: 'posted' as JournalEntryStatus,
      lines: [],
    }

    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: postedEntry, error: null }),
          }),
        }),
      })),
      // Atomic RPC returns the assigned voucher number
      rpc: vi.fn().mockResolvedValue({ data: [{ voucher_number: 3 }], error: null }),
    }

    const result = await commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1')

    expect(result.voucher_number).toBe(3)
    expect(result.status).toBe('posted')
    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: null,
      p_rubric_version: null,
      p_actor_type: null,
      p_actor_label: null,
    })
    // from() called once to fetch the complete entry with lines
    expect(supabase.from).toHaveBeenCalledWith('journal_entries')
  })

  it.each([
    {
      name: 'database error',
      readback: { data: null, error: { message: 'connection reset', code: '08006' } },
    },
    {
      name: 'null row',
      readback: { data: null, error: null },
    },
  ])('commitEntry preserves durable identity when posted readback returns $name', async ({ readback }) => {
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(readback),
          }),
        }),
      })),
      rpc: vi.fn().mockResolvedValue({
        data: [{ voucher_number: 37 }],
        error: null,
      }),
    }

    await expect(
      commitEntry(supabase as never, 'co-1', 'user-1', 'entry-posted'),
    ).rejects.toMatchObject({
      name: 'PostCommitReadbackError',
      journalEntryId: 'entry-posted',
      voucherNumber: 37,
    })
    expect(eventBus.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal_entry.committed' }),
    )
  })

  /**
   * Actor attribution (migration 20260619120000): commitEntry forwards the
   * surrounding runWithActor() scope to the RPC so the immutable layer can
   * record WHO relayed the commit. Outside a scope the params stay null
   * (asserted by the two tests above).
   */
  it('commitEntry forwards the runWithActor scope to the RPC', async () => {
    const postedEntry = {
      id: 'entry-1',
      company_id: 'co-1',
      voucher_number: 1,
      status: 'posted' as JournalEntryStatus,
      lines: [],
    }
    const supabase = {
      from: vi.fn().mockImplementation(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: postedEntry, error: null }),
          }),
        }),
      })),
      rpc: vi.fn().mockResolvedValue({ data: [{ voucher_number: 1 }], error: null }),
    }

    await runWithActor({ type: 'api_key', label: 'Claude Desktop' }, () =>
      commitEntry(supabase as never, 'co-1', 'user-1', 'entry-1', 'api_key')
    )

    expect(supabase.rpc).toHaveBeenCalledWith('commit_journal_entry', {
      p_company_id: 'co-1',
      p_entry_id: 'entry-1',
      p_commit_method: 'api_key',
      p_rubric_version: null,
      p_actor_type: 'api_key',
      p_actor_label: 'Claude Desktop',
    })
  })

  /**
   * getNextVoucherNumber is still used by reverseEntry and storno-service.
   * Those flows INSERT a new entry (not UPDATE a draft), so the atomic
   * commit_journal_entry RPC doesn't apply. Burned numbers can still occur
   * in reversal/correction flows if the INSERT fails after the counter
   * increments. This is documented and expected.
   */
  it('getNextVoucherNumber remains available for reversal/storno flows', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 7, error: null }),
    }

    const num = await getNextVoucherNumber(supabase as never, 'co-1', 'fp-1', 'B')

    expect(num).toBe(7)
    expect(supabase.rpc).toHaveBeenCalledWith('next_voucher_number', {
      p_company_id: 'co-1',
      p_fiscal_period_id: 'fp-1',
      p_series: 'B',
    })
  })
})

describe('createJournalEntry orphan draft cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * Regression test for #292: when commit_journal_entry RPC fails (e.g. overload
   * ambiguity, balance trigger, period lock), the draft created by createDraftEntry
   * must be cancelled so it doesn't linger as an undeletable stuck draft.
   */
  it.each(['returned', 'thrown'] as const)(
  'cancels the company-scoped draft when a %s commit RPC failure is proven unposted', async (failureKind) => {
    const draftId = 'entry-1'
    const cancelUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    })

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { account_number: '1930', id: 'acc-1930' },
                      { account_number: '1510', id: 'acc-1510' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft', lines: [] },
                  error: null,
                }),
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { status: 'draft', voucher_number: 0 },
                    error: null,
                  }),
                }),
              }),
            }),
            update: cancelUpdate,
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return {}
      }),
      // commit_journal_entry RPC fails: simulates overload ambiguity or balance error
      rpc: failureKind === 'returned'
        ? vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Could not choose the best candidate function' },
          })
        : vi.fn().mockRejectedValue(new TypeError('commit transport failed')),
    }

    await expect(
      createJournalEntry(supabase as never, 'co-1', 'user-1', {
        fiscal_period_id: 'fp-1',
        entry_date: '2025-06-15',
        description: 'Payment',
        source_type: 'invoice_paid',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      })
    ).rejects.toThrow(BookkeepingDatabaseError)

    // The orphan draft must have been cancelled with CAS guard (status='draft')
    expect(cancelUpdate).toHaveBeenCalledWith({ status: 'cancelled' })
    const firstEq = cancelUpdate.mock.results[0].value.eq
    expect(firstEq).toHaveBeenCalledWith('id', draftId)
    const secondEq = firstEq.mock.results[0].value.eq
    expect(secondEq).toHaveBeenCalledWith('company_id', 'co-1')
    const thirdEq = secondEq.mock.results[0].value.eq
    expect(thirdEq).toHaveBeenCalledWith('status', 'draft')
  })

  it('never attempts draft cancellation after a durable commit with failed readback', async () => {
    const draftId = 'entry-posted'
    const cancelUpdate = vi.fn()
    let completeReadCount = 0
    const draft = {
      id: draftId,
      company_id: 'co-1',
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      voucher_number: 0,
      status: 'draft' as JournalEntryStatus,
      lines: [],
    }

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: {
                      name: 'FY 2025',
                      period_start: '2025-01-01',
                      period_end: '2025-12-31',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { account_number: '1930', id: 'acc-1930' },
                      { account_number: '1510', id: 'acc-1510' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: draft, error: null }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockImplementation(async () => {
                  completeReadCount++
                  return completeReadCount === 1
                    ? { data: draft, error: null }
                    : { data: null, error: { message: 'read timed out', code: '57014' } }
                }),
              }),
            }),
            update: cancelUpdate,
          }
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        return {}
      }),
      rpc: vi.fn().mockResolvedValue({
        data: [{ voucher_number: 12 }],
        error: null,
      }),
    }

    await expect(
      createJournalEntry(supabase as never, 'co-1', 'user-1', {
        fiscal_period_id: 'fp-1',
        entry_date: '2025-06-15',
        description: 'Payment',
        source_type: 'invoice_paid',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'PostCommitReadbackError',
      journalEntryId: draftId,
      voucherNumber: 12,
    })
    expect(cancelUpdate).not.toHaveBeenCalled()
  })

  it('surfaces original commit error even if cleanup update fails', async () => {
    const draftId = 'entry-1'

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [
                      { account_number: '1930', id: 'acc-1930' },
                      { account_number: '1510', id: 'acc-1510' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: draftId, status: 'draft', lines: [] },
                  error: null,
                }),
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { status: 'draft', voucher_number: 0 },
                    error: null,
                  }),
                }),
              }),
            }),
            // Cleanup throws: original error should still propagate
            update: vi.fn().mockImplementation(() => {
              throw new Error('Network error during rollback')
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return {}
      }),
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Period is locked' },
      }),
    }

    await expect(
      createJournalEntry(supabase as never, 'co-1', 'user-1', {
        fiscal_period_id: 'fp-1',
        entry_date: '2025-06-15',
        description: 'Payment',
        source_type: 'invoice_paid',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      })
      // Original commit error surfaces, not the cleanup error
    ).rejects.toThrow('Period is locked')
  })
})
