import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { JournalEntry, JournalEntryLine, Transaction, TransactionCategory } from '@/types'

const log = createLogger('categorization-attachment')

interface CategorizationAttachmentResult {
  status: 'applied' | 'already_applied'
  readback: {
    transaction: Record<string, unknown>
  }
}

function isAttachmentResult(value: unknown): value is CategorizationAttachmentResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (result.status !== 'applied' && result.status !== 'already_applied') return false
  if (!result.readback || typeof result.readback !== 'object') return false
  const transaction = (result.readback as Record<string, unknown>).transaction
  return Boolean(transaction && typeof transaction === 'object')
}

function readbackMatches(
  result: CategorizationAttachmentResult,
  companyId: string,
  transaction: Transaction,
  journalEntry: JournalEntry,
  category: TransactionCategory,
  isBusiness: boolean,
  amountSek: number,
): boolean {
  const readback = result.readback.transaction
  return (
    readback.id === transaction.id
    && readback.companyId === companyId
    && readback.journalEntryId === journalEntry.id
    && readback.cashAccountId === transaction.cash_account_id
    && readback.category === category
    && readback.isBusiness === isBusiness
    && typeof readback.amountSek === 'number'
    && roundOre(readback.amountSek) === amountSek
  )
}

function expectedLines(lines: JournalEntryLine[]): Array<Record<string, unknown>> {
  return lines.map((line) => ({
    account_number: line.account_number,
    account_id: line.account_id,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    currency: line.currency,
    amount_in_currency: line.amount_in_currency,
    exchange_rate: line.exchange_rate,
    line_description: line.line_description,
    sort_order: line.sort_order,
    tax_code: line.tax_code,
    dimensions: line.dimensions ?? {},
  }))
}

function settlementAccount(
  transaction: Transaction,
  lines: JournalEntryLine[],
  amountSek: number,
): string | null {
  const line = lines.find((candidate) =>
    transaction.amount >= 0
      ? roundOre(candidate.debit_amount) === amountSek
      : roundOre(candidate.credit_amount) === amountSek,
  )
  return line?.account_number ?? null
}

async function compensateAttachmentFailure(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionId: string,
  journalEntryId: string,
): Promise<void> {
  const { data: current, error: readError } = await supabase
    .from('transactions')
    .select('journal_entry_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()

  if (readError) {
    log.error('failed to resolve categorization attachment outcome', readError, {
      companyId,
      transactionId,
      journalEntryId,
    })
    return
  }

  if (current?.journal_entry_id === journalEntryId) {
    const actor = getActor()
    const actorType = actor?.type ?? 'user'
    const { error } = await supabase.rpc('compensate_transaction_categorization', {
      p_company_id: companyId,
      p_transaction_id: transactionId,
      p_original_journal_entry_id: journalEntryId,
      p_actor_type: actorType,
      p_actor_id: actorType === 'user' ? userId : null,
      p_actor_label: actor?.label ?? null,
    })
    if (error) {
      log.error('failed to compensate attached categorization', error, {
        companyId,
        transactionId,
        journalEntryId,
      })
    }
    return
  }

  await reverseOrphanedJournalEntry(
    supabase,
    companyId,
    userId,
    journalEntryId,
    'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
  )
}

/**
 * Atomically attach one exact posted bank-transaction voucher through the
 * guarded database command. The draft provenance, posted lines, transaction
 * version, and settlement account are all supplied as optimistic preconditions.
 */
export async function attachTransactionCategorization(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transaction: Transaction,
  journalEntry: JournalEntry,
  category: TransactionCategory,
  isBusiness: boolean,
): Promise<Transaction> {
  const lines = journalEntry.lines
  if (!lines || lines.length === 0) {
    await compensateAttachmentFailure(
      supabase,
      companyId,
      userId,
      transaction.id,
      journalEntry.id,
    )
    throw new Error('Categorization journal entry readback has no lines')
  }

  const amountSek = roundOre(lines.reduce((sum, line) => sum + line.debit_amount, 0))
  const expectedSettlementAccount = settlementAccount(transaction, lines, amountSek)
  if (!expectedSettlementAccount) {
    await compensateAttachmentFailure(
      supabase,
      companyId,
      userId,
      transaction.id,
      journalEntry.id,
    )
    throw new Error('Categorization journal entry has no settlement line')
  }

  const { data, error } = await supabase.rpc('attach_transaction_categorization', {
    p_company_id: companyId,
    p_transaction_id: transaction.id,
    p_expected_journal_entry_id: transaction.journal_entry_id,
    p_journal_entry_id: journalEntry.id,
    p_user_id: userId,
    p_expected_amount_sek: amountSek,
    p_expected_settlement_account: expectedSettlementAccount,
    p_expected_cash_account_id: transaction.cash_account_id,
    p_expected_category: category,
    p_expected_is_business: isBusiness,
    p_expected_lines: expectedLines(lines),
  })

  if (
    error
    || !isAttachmentResult(data)
    || !readbackMatches(data, companyId, transaction, journalEntry, category, isBusiness, amountSek)
  ) {
    await compensateAttachmentFailure(
      supabase,
      companyId,
      userId,
      transaction.id,
      journalEntry.id,
    )
    if (error) throw error
    throw new Error('Invalid categorization attachment response')
  }

  return {
    ...transaction,
    category,
    is_business: isBusiness,
    is_ignored: false,
    journal_entry_id: journalEntry.id,
  }
}
