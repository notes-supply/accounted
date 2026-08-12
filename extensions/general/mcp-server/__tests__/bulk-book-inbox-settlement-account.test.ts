import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

const bulkBookInbox = tools.find((tool) => tool.name === 'gnubok_bulk_book_inbox_items')!

type MockResult = { data?: unknown; error?: unknown }

function makeCapturingSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [table, value] of Object.entries(byTable)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value])
  }
  const inserts: Record<string, unknown[]> = {}
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (table: string): unknown => new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => void) => {
          const queue = queues.get(table)
          const next = queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? { data: null, error: null })
          resolve({ count: null, ...next })
        }
      }
      return (...args: unknown[]) => {
        calls.push({ table, method: String(prop), args })
        if (prop === 'insert') (inserts[table] ??= []).push(args[0])
        return buildChain(table)
      }
    },
  })
  return {
    calls,
    inserts,
    from: vi.fn((table: string) => buildChain(table)),
  }
}

const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const TX_ID = '22222222-2222-4222-8222-222222222222'
const CASH_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('gnubok_bulk_book_inbox_items settlement provenance', () => {
  it('stages exact per-item Revolut SEK settlement evidence in params and preview', async () => {
    const supabase = makeCapturingSupabase({
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [{
          id: ITEM_ID,
          matched_transaction_id: TX_ID,
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
        }],
      },
      transactions: {
        data: [{
          id: TX_ID,
          date: '2026-08-02',
          amount: -150,
          currency: 'SEK',
          amount_sek: null,
          exchange_rate: null,
          cash_account_id: CASH_ACCOUNT_ID,
        }],
      },
      cash_accounts: { data: { ledger_account: '1931' }, error: null },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-revolut' }, error: null },
    })

    const result = await bulkBookInbox.execute(
      { item_ids: [ITEM_ID], category: 'expense_bank_fees' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'user' },
    ) as { staged: boolean; preview: Record<string, unknown> }

    const expected = [{
      item_id: ITEM_ID,
      transaction_id: TX_ID,
      cash_account_id: CASH_ACCOUNT_ID,
      settlement_account: '1931',
    }]
    expect(result.staged).toBe(true)
    expect(result.preview.expected_settlements).toEqual(expected)
    const inserted = supabase.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params.expected_settlements).toEqual(expected)
    expect(supabase.calls).toContainEqual({
      table: 'cash_accounts',
      method: 'eq',
      args: ['company_id', 'company-1'],
    })
  })

  it('persists the legacy 1930 fallback only for an explicitly null cash account', async () => {
    const supabase = makeCapturingSupabase({
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [{
          id: ITEM_ID,
          matched_transaction_id: TX_ID,
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
        }],
      },
      transactions: {
        data: [{
          id: TX_ID,
          date: '2026-08-02',
          amount: -150,
          currency: 'SEK',
          amount_sek: null,
          exchange_rate: null,
          cash_account_id: null,
        }],
      },
      fiscal_periods: { data: null },
      pending_operations: { data: { id: 'op-legacy' }, error: null },
    })

    await bulkBookInbox.execute(
      { item_ids: [ITEM_ID], category: 'expense_bank_fees' },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'user' },
    )

    const inserted = supabase.inserts.pending_operations?.[0] as {
      params: Record<string, unknown>
    }
    expect(inserted.params.expected_settlements).toEqual([{
      item_id: ITEM_ID,
      transaction_id: TX_ID,
      cash_account_id: null,
      settlement_account: '1930',
    }])
    expect(supabase.from).not.toHaveBeenCalledWith('cash_accounts')
  })

  it.each([
    { name: 'missing or cross-company cash account', cashAccount: null },
    { name: 'ledger-less cash account', cashAccount: { ledger_account: null } },
  ])('fails closed for a $name before staging', async ({ cashAccount }) => {
    const supabase = makeCapturingSupabase({
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [{
          id: ITEM_ID,
          matched_transaction_id: TX_ID,
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
        }],
      },
      transactions: {
        data: [{
          id: TX_ID,
          date: '2026-08-02',
          amount: -150,
          currency: 'SEK',
          cash_account_id: CASH_ACCOUNT_ID,
        }],
      },
      cash_accounts: { data: cashAccount, error: null },
    })

    await expect(
      bulkBookInbox.execute(
        { item_ids: [ITEM_ID], category: 'expense_bank_fees' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'user' },
      ),
    ).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'resolve_settlement_account',
    })
    expect(supabase.inserts.pending_operations).toBeUndefined()
  })

  it('fails closed when a matched transaction cannot be authoritatively read', async () => {
    const supabase = makeCapturingSupabase({
      company_settings: { data: { dimensions_enabled: false } },
      invoice_inbox_items: {
        data: [{
          id: ITEM_ID,
          matched_transaction_id: TX_ID,
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
        }],
      },
      transactions: { data: [], error: null },
    })

    await expect(
      bulkBookInbox.execute(
        { item_ids: [ITEM_ID], category: 'expense_bank_fees' },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'user' },
      ),
    ).rejects.toThrow(/banktransaktion/i)
    expect(supabase.inserts.pending_operations).toBeUndefined()
  })
})
