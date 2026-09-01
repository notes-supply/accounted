import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueuedMockSupabase,
  makeJournalEntry,
  makeJournalEntryLine,
  makeTransaction,
} from '@/tests/helpers'

const reverseOrphanedJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => reverseOrphanedJournalEntry(...args),
}))

import { attachTransactionCategorization } from '../categorization-attachment'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

function transactionAndEntry() {
  const transaction = makeTransaction({
    id: 'tx-1',
    company_id: 'company-1',
    user_id: 'user-1',
    amount: -100,
    cash_account_id: 'cash-1',
    journal_entry_id: null,
    is_ignored: true,
  })
  const entry = makeJournalEntry({
    id: 'je-1',
    company_id: 'company-1',
    user_id: 'user-1',
    source_type: 'bank_transaction',
    source_id: 'tx-1',
    lines: [
      makeJournalEntryLine({
        id: 'line-expense',
        journal_entry_id: 'je-1',
        account_number: '5420',
        debit_amount: 100,
        sort_order: 0,
      }),
      makeJournalEntryLine({
        id: 'line-bank',
        journal_entry_id: 'je-1',
        account_number: '1931',
        debit_amount: 0,
        credit_amount: 100,
        sort_order: 1,
      }),
    ],
  })
  return { transaction, entry }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('attachTransactionCategorization', () => {
  it.each(['applied', 'already_applied'] as const)(
    'accepts the idempotent %s readback and returns the complete transaction shape',
    async (status) => {
      const { transaction, entry } = transactionAndEntry()
      enqueue({
        data: {
          status,
          readback: {
            transaction: {
              id: 'tx-1',
              companyId: 'company-1',
              journalEntryId: 'je-1',
              cashAccountId: 'cash-1',
              amountSek: 100,
              category: 'expense_software',
              isBusiness: true,
            },
          },
        },
        error: null,
      })

      const result = await attachTransactionCategorization(
        supabase as never,
        'company-1',
        'user-1',
        transaction,
        entry,
        'expense_software',
        true,
      )

      expect(result).toMatchObject({
        id: 'tx-1',
        category: 'expense_software',
        is_business: true,
        is_ignored: false,
        journal_entry_id: 'je-1',
      })
      expect(result).not.toHaveProperty('journalEntryId')
      expect(result).not.toHaveProperty('isBusiness')
      expect(supabase.rpc).toHaveBeenCalledWith(
        'attach_transaction_categorization',
        expect.objectContaining({
          p_company_id: 'company-1',
          p_transaction_id: 'tx-1',
          p_expected_journal_entry_id: null,
          p_journal_entry_id: 'je-1',
          p_user_id: 'user-1',
          p_expected_amount_sek: 100,
          p_expected_settlement_account: '1931',
          p_expected_cash_account_id: 'cash-1',
          p_expected_category: 'expense_software',
          p_expected_is_business: true,
          p_expected_lines: expect.arrayContaining([
            expect.objectContaining({
              account_number: '1931',
              credit_amount: 100,
              sort_order: 1,
            }),
          ]),
        }),
      )
      expect(reverseOrphanedJournalEntry).not.toHaveBeenCalled()
    },
  )

  it('stornos an unattached posted voucher when the attachment command fails', async () => {
    const { transaction, entry } = transactionAndEntry()
    enqueue({ data: null, error: { code: '40001', message: 'pointer drifted' } })
    enqueue({ data: { journal_entry_id: null }, error: null })

    await expect(
      attachTransactionCategorization(
        supabase as never,
        'company-1',
        'user-1',
        transaction,
        entry,
        'expense_software',
        true,
      ),
    ).rejects.toMatchObject({ code: '40001' })

    expect(reverseOrphanedJournalEntry).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('uses M5 compensation when an uncertain response already attached the voucher', async () => {
    const { transaction, entry } = transactionAndEntry()
    enqueue({ data: null, error: { message: 'response lost' } })
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { status: 'applied' }, error: null })

    await expect(
      attachTransactionCategorization(
        supabase as never,
        'company-1',
        'user-1',
        transaction,
        entry,
        'expense_software',
        true,
      ),
    ).rejects.toMatchObject({ message: 'response lost' })

    expect(supabase.rpc).toHaveBeenNthCalledWith(
      2,
      'compensate_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_original_journal_entry_id: 'je-1',
        p_actor_type: 'user',
        p_actor_id: 'user-1',
        p_actor_label: null,
      },
    )
    expect(reverseOrphanedJournalEntry).not.toHaveBeenCalled()
  })
})
