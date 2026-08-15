import { describe, expect, it, vi } from 'vitest'
import { compensateTransactionCategorization } from '@/lib/bookkeeping/engine'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'

const emit = vi.hoisted(() => vi.fn().mockResolvedValue([]))
vi.mock('@/lib/events', () => ({ eventBus: { emit } }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('durable categorization compensation', () => {
  it('keeps a non-user ambient actor ID null and returns stored retry identity', async () => {
    const outcome = {
      status: 'already_applied' as const,
      company_id: 'co-1',
      transaction_id: 'transaction-1',
      root_journal_entry_id: 'entry-1',
      original_journal_entry_id: 'entry-1',
      reversal_journal_entry_id: 'storno-1',
      actor_type: 'api_key' as const,
      actor_id: 'key-1',
      actor_label: 'Automation key',
      publications: [
        {
          publication_id: 'publication-1',
          event_key: 'journal:storno-1:committed',
          event_type: 'journal_entry.committed' as const,
        },
        {
          publication_id: 'publication-2',
          event_key: 'journal:entry-1:reversed',
          event_type: 'journal_entry.reversed' as const,
        },
      ] as const,
    }
    const original = {
      id: 'entry-1',
      company_id: 'co-1',
      status: 'reversed',
      reversed_by_id: 'storno-1',
      lines: [],
    }
    const reversal = {
      id: 'storno-1',
      company_id: 'co-1',
      status: 'posted',
      source_type: 'storno',
      reverses_id: 'entry-1',
      lines: [],
    }
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'connection lost after commit' },
      })
      .mockResolvedValueOnce({ data: outcome, error: null })
    const single = vi.fn()
      .mockResolvedValueOnce({ data: original, error: null })
      .mockResolvedValueOnce({ data: reversal, error: null })
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn().mockReturnValue(chain)
    chain.eq = vi.fn().mockReturnValue(chain)
    chain.single = single
    const supabase = {
      rpc,
      from: vi.fn().mockReturnValue(chain),
    }

    const result = await runWithActor(
      {
        type: 'api_key',
        label: 'Automation key',
      },
      () => compensateTransactionCategorization(
        supabase as never,
        {
          companyId: 'co-1',
          userId: 'fallback-user',
          transactionId: 'transaction-1',
          originalJournalEntryId: 'entry-1',
        },
      ),
    )

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      {
        p_company_id: 'co-1',
        p_transaction_id: 'transaction-1',
        p_original_journal_entry_id: 'entry-1',
        p_actor_type: 'api_key',
        p_actor_id: null,
        p_actor_label: 'Automation key',
      },
    )
    expect(result).toMatchObject({
      outcome,
      originalEntry: original,
      reversalEntry: reversal,
    })
    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'journal_entry.committed',
      payload: {
        entry: reversal,
        userId: 'fallback-user',
        companyId: 'co-1',
        durablePublication: {
          persisted: true,
          publication_id: 'publication-1',
          event_key: 'journal:storno-1:committed',
        },
      },
    })
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: 'journal_entry.reversed',
      payload: {
        originalEntry: original,
        reversalEntry: reversal,
        userId: 'fallback-user',
        companyId: 'co-1',
        durablePublication: {
          persisted: true,
          publication_id: 'publication-2',
          event_key: 'journal:entry-1:reversed',
        },
      },
    })
  })
})
