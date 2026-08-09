import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { makeJournalEntry, makeJournalEntryLine } from '@/tests/helpers'
import { compensateTransactionCategorization } from '../engine'

function compensationEntryFixtures() {
  const originalLine = makeJournalEntryLine({
    id: 'line-original',
    journal_entry_id: 'je-original',
    debit_amount: 100,
  })
  const reversalLine = makeJournalEntryLine({
    id: 'line-reversal',
    journal_entry_id: 'je-reversal',
    debit_amount: 0,
    credit_amount: 100,
  })
  const original = makeJournalEntry({
    id: 'je-original',
    company_id: 'company-1',
    source_type: 'bank_transaction',
    source_id: 'tx-1',
    status: 'reversed',
    reversed_by_id: 'je-reversal',
    lines: [originalLine],
  })
  const reversal = makeJournalEntry({
    id: 'je-reversal',
    company_id: 'company-1',
    source_type: 'storno',
    source_id: 'tx-1',
    status: 'posted',
    reverses_id: 'je-original',
    lines: [reversalLine],
  })
  return { original, reversal }
}

function createSupabase(
  rpcResult: { data: unknown; error: unknown },
  entryResults: Array<{ data: unknown; error: unknown }> = [],
) {
  const filters: Array<Array<[string, unknown]>> = []
  const from = vi.fn(() => {
    const result = entryResults.shift() ?? { data: null, error: null }
    const queryFilters: Array<[string, unknown]> = []
    filters.push(queryFilters)
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      queryFilters.push([column, value])
      return chain
    })
    chain.single = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return {
    supabase: {
      rpc: vi.fn().mockResolvedValue(rpcResult),
      from,
    },
    filters,
  }
}

const params = {
  companyId: 'company-1',
  userId: 'user-1',
  transactionId: 'tx-1',
  originalJournalEntryId: 'je-original',
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('compensateTransactionCategorization', () => {
  it('hydrates the exact storno pair and publishes reverseEntry-shaped events on new compensation', async () => {
    const { original, reversal } = compensationEntryFixtures()
    const { supabase, filters } = createSupabase(
      {
        data: {
          status: 'reversed',
          original_journal_entry_id: 'je-original',
          reversal_journal_entry_ids: ['je-reversal'],
          original_pointer_cleared: true,
        },
        error: null,
      },
      [
        { data: original, error: null },
        { data: reversal, error: null },
      ],
    )
    const emit = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toEqual({
      compensationVerified: true,
      status: 'reversed',
      originalEntry: original,
      reversalEntry: reversal,
    })
    expect(supabase.rpc).toHaveBeenCalledWith('compensate_transaction_categorization', {
      p_company_id: 'company-1',
      p_transaction_id: 'tx-1',
      p_original_journal_entry_id: 'je-original',
    })
    expect(filters).toEqual([
      [['id', 'je-original'], ['company_id', 'company-1']],
      [['id', 'je-reversal'], ['company_id', 'company-1']],
    ])
    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'journal_entry.committed',
      payload: { entry: reversal, userId: 'user-1', companyId: 'company-1' },
    })
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: 'journal_entry.reversed',
      payload: {
        originalEntry: original,
        reversalEntry: reversal,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('does not report hydration failure as verified and preserves both posted ids', async () => {
    const { supabase } = createSupabase(
      {
        data: {
          status: 'reversed',
          original_journal_entry_id: 'je-original',
          reversal_journal_entry_ids: ['je-reversal'],
          original_pointer_cleared: true,
        },
        error: null,
      },
      [{ data: null, error: { message: 'readback unavailable' } }],
    )
    const emit = vi.spyOn(eventBus, 'emit')

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toMatchObject({
      compensationVerified: false,
      partialPostedIds: {
        journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-reversal',
      },
      error: { operation: 'verify_transaction_compensation' },
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not report event-publication failure as verified and preserves both posted ids', async () => {
    const { original, reversal } = compensationEntryFixtures()
    const { supabase } = createSupabase(
      {
        data: {
          status: 'reversed',
          original_journal_entry_id: 'je-original',
          reversal_journal_entry_ids: ['je-reversal'],
          original_pointer_cleared: true,
        },
        error: null,
      },
      [
        { data: original, error: null },
        { data: reversal, error: null },
      ],
    )
    vi.spyOn(eventBus, 'emit').mockRejectedValueOnce(new Error('event store unavailable'))

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toMatchObject({
      compensationVerified: false,
      partialPostedIds: {
        journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-reversal',
      },
      error: { operation: 'verify_transaction_compensation' },
    })
  })

  it('preserves every RPC-reported id when the mutation outcome is erroneous', async () => {
    const { supabase } = createSupabase({
      data: {
        status: 'ambiguous_existing_reversals',
        original_journal_entry_id: 'je-original',
        reversal_journal_entry_ids: ['je-reversal', 'je-reversal-2'],
        original_pointer_cleared: false,
      },
      error: { message: 'response lost after commit' },
    })

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toMatchObject({
      compensationVerified: false,
      partialPostedIds: {
        journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-reversal',
        reversal_journal_entry_2_id: 'je-reversal-2',
      },
      error: { operation: 'compensate_transaction_categorization' },
    })
  })

  it('verifies already_reversed idempotently without replaying journal events', async () => {
    const { original, reversal } = compensationEntryFixtures()
    const { supabase } = createSupabase(
      {
        data: {
          status: 'already_reversed',
          original_journal_entry_id: 'je-original',
          reversal_journal_entry_ids: ['je-reversal'],
          original_pointer_cleared: true,
        },
        error: null,
      },
      [
        { data: original, error: null },
        { data: reversal, error: null },
      ],
    )
    const emit = vi.spyOn(eventBus, 'emit')

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toMatchObject({
      compensationVerified: true,
      status: 'already_reversed',
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('publishes events when this call adopts a sole reversal and completes compensation', async () => {
    const { original, reversal } = compensationEntryFixtures()
    const { supabase } = createSupabase(
      {
        data: {
          status: 'recovered_existing_reversal',
          original_journal_entry_id: 'je-original',
          reversal_journal_entry_ids: ['je-reversal'],
          original_pointer_cleared: true,
        },
        error: null,
      },
      [
        { data: original, error: null },
        { data: reversal, error: null },
      ],
    )
    const emit = vi.spyOn(eventBus, 'emit').mockResolvedValue(undefined)

    const result = await compensateTransactionCategorization(supabase as never, params)

    expect(result).toMatchObject({
      compensationVerified: true,
      status: 'recovered_existing_reversal',
    })
    expect(emit).toHaveBeenCalledTimes(2)
  })
})
