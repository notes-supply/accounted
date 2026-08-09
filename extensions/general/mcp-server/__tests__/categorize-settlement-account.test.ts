import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mockResolveSettlementAccount = vi.fn()

vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))

import { tools } from '../server'

const categorize = tools.find((tool) => tool.name === 'gnubok_categorize_transaction')!

const transaction = {
  id: 'tx-revolut-fee',
  date: '2026-08-02',
  amount: -150,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  description: 'Company Free plan fee',
  merchant_name: 'Revolut',
  cash_account_id: 'cash-revolut-sek',
  document_id: null,
  journal_entry_id: null,
  is_business: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolveSettlementAccount.mockResolvedValue('1931')
})

describe('gnubok_categorize_transaction settlement account preview', () => {
  it('stages an outgoing Revolut SEK fee with a 1931 bank leg', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: transaction, error: null })
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: transaction, error: null })
    enqueue({ data: null, error: null }) // period status layer 1
    enqueue({ data: null, error: null }) // period status layer 2
    enqueue({ data: { id: 'op-revolut-fee' }, error: null })

    const result = (await categorize.execute(
      {
        transaction_id: transaction.id,
        category: 'expense_bank_fees',
        vat_treatment: 'exempt',
        allow_duplicate: true,
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )) as {
      staged: boolean
      preview: {
        debit_account: string
        credit_account: string
        lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      }
    }

    expect(result.staged).toBe(true)
    expect(mockResolveSettlementAccount).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'cash-revolut-sek',
      expect.anything(),
    )
    expect(result.preview.debit_account).toBe('6570')
    expect(result.preview.credit_account).toBe('1931')
    expect(result.preview.lines).toEqual([
      { account_number: '6570', debit_amount: 150, credit_amount: 0, description: 'Company Free plan fee' },
      { account_number: '1931', debit_amount: 0, credit_amount: 150, description: 'Company Free plan fee' },
    ])

    const staged = findCall('pending_operations', 'insert')?.[0] as {
      params: Record<string, unknown>
    }
    expect(staged.params).toMatchObject({
      transaction_id: transaction.id,
      cash_account_id: 'cash-revolut-sek',
      settlement_account: '1931',
    })
  })

  it('uses legacy sole-trader defaults only when the company-settings row is absent', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: transaction, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: transaction, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-legacy' }, error: null })

    const result = await categorize.execute(
      {
        transaction_id: transaction.id,
        category: 'expense_bank_fees',
        vat_treatment: 'exempt',
        allow_duplicate: true,
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    ) as { staged: boolean }

    expect(result.staged).toBe(true)
    expect(findCall('pending_operations', 'insert')).toBeDefined()
  })

  it('stops before preview mutation when company-settings lookup fails', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: transaction, error: null })
    enqueue({ data: null, error: { code: '42501', message: 'permission denied' } })

    await expect(
      categorize.execute(
        {
          transaction_id: transaction.id,
          category: 'expense_bank_fees',
          vat_treatment: 'exempt',
          allow_duplicate: true,
        },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      ),
    ).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'fetch_company_settings',
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
