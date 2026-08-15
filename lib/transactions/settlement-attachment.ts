import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  commitEntry,
  createDraftEntry,
  findFiscalPeriod,
} from '@/lib/bookkeeping/engine'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import { roundOre } from '@/lib/money'
import type {
  CreateJournalEntryInput,
  JournalEntry,
  MappingResult,
  Transaction,
  TransactionCategory,
} from '@/types'

export const SETTLEMENT_SNAPSHOT_CONFLICT = 'SETTLEMENT_SNAPSHOT_CONFLICT' as const
export const SETTLEMENT_ATTACHMENT_PARTIAL = 'SETTLEMENT_ATTACHMENT_PARTIAL' as const

export interface SettlementSnapshotLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions: Record<string, string>
}

export interface SettlementSnapshot {
  companyId: string
  transactionId: string
  expectedJournalEntryId: string | null
  cashAccountId: string | null
  settlementAccount: string
  amountSek: number
  category: TransactionCategory
  isBusiness: boolean
  lines: SettlementSnapshotLine[]
}

export interface SettlementReadback {
  transaction: {
    id: string
    companyId: string
    journalEntryId: string
    cashAccountId: string | null
    amountSek: number
    category: TransactionCategory
    isBusiness: boolean
  }
  journalEntry: {
    id: string
    companyId: string
    status: string
    sourceType: string
    sourceId: string | null
    category: TransactionCategory | null
    isBusiness: boolean | null
    lines: SettlementSnapshotLine[]
  }
  cashAccount: {
    id: string
    companyId: string
    ledgerAccount: string
  } | null
}

export interface SettlementPublicationIdentity {
  publication_id: string
  event_key: string
  event_type: 'journal_entry.committed' | 'journal_entry.reversed'
}

export interface SettlementAttachmentOutcome {
  status: 'applied' | 'already_applied'
  company_id: string
  transaction_id: string
  journal_entry_id: string
  readback: SettlementReadback
  publication: SettlementPublicationIdentity
}

export interface SettlementCompensationOutcome {
  status: 'applied' | 'already_applied'
  company_id: string
  transaction_id: string
  root_journal_entry_id: string
  original_journal_entry_id: string
  reversal_journal_entry_id: string
  actor_type: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'system' | 'agent_chat'
  actor_id: string | null
  actor_label: string | null
  publications: [SettlementPublicationIdentity, SettlementPublicationIdentity]
}

export interface SettlementPostInput {
  supabase: SupabaseClient
  companyId: string
  userId: string
  transaction: Transaction
  mappingResult: MappingResult
  notes?: string
  snapshot: SettlementSnapshot
}

/**
 * Narrow contracts for the engine, M4 attachment, and M5 compensation boundaries.
 * The journal implementation must defer committed publication until attachment is
 * verified. The two mutation methods must each be one RPC backed database transaction.
 */
export interface SettlementCoordinatorDependencies {
  post(input: SettlementPostInput): Promise<JournalEntry>
  attach(input: {
    supabase: SupabaseClient
    snapshot: SettlementSnapshot
    userId: string
    journalEntryId: string
  }): Promise<unknown>
  readback(input: {
    supabase: SupabaseClient
    snapshot: SettlementSnapshot
    journalEntryId: string
  }): Promise<SettlementReadback | null>
  compensate(input: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    transactionId: string
    originalJournalEntryId: string
  }): Promise<unknown>
}

export type SettlementCoordinatorResult =
  | {
      kind: 'attached'
      created: true
      readback: SettlementReadback
      publication: SettlementPublicationIdentity
      journalEntry: JournalEntry
    }
  | {
      kind: 'attached'
      created: false
      readback: SettlementReadback
    }
  | {
      kind: 'conflict'
      code: typeof SETTLEMENT_SNAPSHOT_CONFLICT
      message: string
      postedIds: Record<string, string>
    }
  | {
      kind: 'partial'
      code: typeof SETTLEMENT_ATTACHMENT_PARTIAL
      message: string
      postedIds: Record<string, string>
      publicationIds: string[]
    }


function normalizeDimensions(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

function normalizeLine(line: {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string | null
  dimensions?: unknown
}): SettlementSnapshotLine {
  return {
    account_number: String(line.account_number),
    debit_amount: roundOre(Number(line.debit_amount)),
    credit_amount: roundOre(Number(line.credit_amount)),
    line_description: line.line_description ?? null,
    dimensions: normalizeDimensions(line.dimensions),
  }
}

function canonicalLines(lines: SettlementSnapshotLine[]): string[] {
  return lines.map((line) => JSON.stringify(normalizeLine(line))).sort()
}

function snapshotsEqual(left: SettlementSnapshot, right: SettlementSnapshot): boolean {
  return (
    left.companyId === right.companyId &&
    left.transactionId === right.transactionId &&
    left.expectedJournalEntryId === right.expectedJournalEntryId &&
    left.cashAccountId === right.cashAccountId &&
    left.settlementAccount === right.settlementAccount &&
    roundOre(left.amountSek) === roundOre(right.amountSek) &&
    left.category === right.category &&
    left.isBusiness === right.isBusiness &&
    JSON.stringify(canonicalLines(left.lines)) === JSON.stringify(canonicalLines(right.lines))
  )
}

export function stageSettlementSnapshot(input: {
  companyId: string
  transaction: Transaction
  mappingResult: MappingResult
  category: TransactionCategory
  isBusiness: boolean
  settlementAccount: string
  expectedJournalEntryId?: string | null
}): SettlementSnapshot {
  const amountSek = resolveTransactionAmountSek(input.transaction)
  if (amountSek === null) {
    throw new Error('Settlement snapshot requires an authoritative SEK amount.')
  }

  return {
    companyId: input.companyId,
    transactionId: input.transaction.id,
    expectedJournalEntryId:
      input.expectedJournalEntryId === undefined
        ? input.transaction.journal_entry_id
        : input.expectedJournalEntryId,
    cashAccountId: input.transaction.cash_account_id,
    settlementAccount: input.settlementAccount,
    amountSek,
    category: input.category,
    isBusiness: input.isBusiness,
    lines: buildTransactionEntryLines(input.transaction, input.mappingResult).map(normalizeLine),
  }
}

function verifyReadback(
  readback: SettlementReadback | null,
  snapshot: SettlementSnapshot,
  journalEntryId: string,
): readback is SettlementReadback {
  if (!readback) return false
  const tx = readback.transaction
  const journal = readback.journalEntry
  if (
    tx.id !== snapshot.transactionId ||
    tx.companyId !== snapshot.companyId ||
    tx.journalEntryId !== journalEntryId ||
    tx.cashAccountId !== snapshot.cashAccountId ||
    roundOre(tx.amountSek) !== roundOre(snapshot.amountSek) ||
    tx.category !== snapshot.category ||
    tx.isBusiness !== snapshot.isBusiness ||
    journal.id !== journalEntryId ||
    journal.companyId !== snapshot.companyId ||
    journal.status !== 'posted' ||
    journal.sourceType !== 'bank_transaction' ||
    journal.sourceId !== snapshot.transactionId ||
    journal.category !== snapshot.category ||
    journal.isBusiness !== snapshot.isBusiness ||
    JSON.stringify(canonicalLines(journal.lines)) !== JSON.stringify(canonicalLines(snapshot.lines))
  ) {
    return false
  }

  if (snapshot.cashAccountId === null) {
    if (readback.cashAccount !== null || snapshot.settlementAccount !== '1930') return false
  } else if (
    !readback.cashAccount ||
    readback.cashAccount.id !== snapshot.cashAccountId ||
    readback.cashAccount.companyId !== snapshot.companyId ||
    readback.cashAccount.ledgerAccount !== snapshot.settlementAccount
  ) {
    return false
  }

  const settlementDebit = snapshot.lines
    .filter((line) => line.account_number === snapshot.settlementAccount)
    .reduce((sum, line) => sum + line.debit_amount, 0)
  const settlementCredit = snapshot.lines
    .filter((line) => line.account_number === snapshot.settlementAccount)
    .reduce((sum, line) => sum + line.credit_amount, 0)
  return snapshot.amountSek === roundOre(Math.max(settlementDebit, settlementCredit))
}

const UnknownRpcObjectSchema = z.record(z.string(), z.unknown())
const SettlementPublicationIdentitySchema = z.object({
  publication_id: z.string().min(1),
  event_key: z.string().min(1),
  event_type: z.enum(['journal_entry.committed', 'journal_entry.reversed']),
})
const SettlementReadbackSchema = z.object({
  transaction: z.object({
    id: z.string(),
    companyId: z.string(),
    journalEntryId: z.string(),
    cashAccountId: z.string().nullable(),
    amountSek: z.number(),
    category: z.string(),
    isBusiness: z.boolean(),
  }),
  journalEntry: z.object({
    id: z.string(),
    companyId: z.string(),
    status: z.string(),
    sourceType: z.string(),
    sourceId: z.string().nullable(),
    category: z.string().nullable(),
    isBusiness: z.boolean().nullable(),
    lines: z.array(z.object({
      account_number: z.string(),
      debit_amount: z.number(),
      credit_amount: z.number(),
      line_description: z.string().nullable(),
      dimensions: z.record(z.string(), z.string()),
    })),
  }),
  cashAccount: z.object({
    id: z.string(),
    companyId: z.string(),
    ledgerAccount: z.string(),
  }).nullable(),
})
const SettlementAttachmentOutcomeSchema = z.object({
  status: z.enum(['applied', 'already_applied']),
  company_id: z.string(),
  transaction_id: z.string(),
  journal_entry_id: z.string(),
  readback: SettlementReadbackSchema,
  publication: SettlementPublicationIdentitySchema,
})
const SettlementCompensationOutcomeSchema = z.object({
  status: z.enum(['applied', 'already_applied']),
  company_id: z.string(),
  transaction_id: z.string(),
  root_journal_entry_id: z.string().min(1),
  original_journal_entry_id: z.string(),
  reversal_journal_entry_id: z.string().min(1),
  actor_type: z.enum([
    'user',
    'api_key',
    'mcp_oauth',
    'cron',
    'system',
    'agent_chat',
  ]),
  actor_id: z.string().nullable(),
  actor_label: z.string().nullable(),
  publications: z.tuple([
    SettlementPublicationIdentitySchema,
    SettlementPublicationIdentitySchema,
  ]),
})

function parseAttachmentOutcome(
  data: unknown,
  snapshot: SettlementSnapshot,
  journalEntryId: string,
): SettlementAttachmentOutcome | null {
  const candidate = Array.isArray(data)
    ? data.length === 1 ? data[0] : undefined
    : data
  const parsed = SettlementAttachmentOutcomeSchema.safeParse(candidate)
  if (!parsed.success) return null
  const row = parsed.data as unknown as SettlementAttachmentOutcome
  if (
    row.company_id !== snapshot.companyId ||
    row.transaction_id !== snapshot.transactionId ||
    row.journal_entry_id !== journalEntryId ||
    !verifyReadback(row.readback, snapshot, journalEntryId) ||
    row.publication.event_type !== 'journal_entry.committed' ||
    row.publication.event_key !== `journal:${journalEntryId}:committed`
  ) {
    return null
  }
  return row
}

function parseCompensationOutcome(
  data: unknown,
  companyId: string,
  transactionId: string,
  originalJournalEntryId: string,
): SettlementCompensationOutcome | null {
  const candidate = Array.isArray(data)
    ? data.length === 1 ? data[0] : undefined
    : data
  const parsed = SettlementCompensationOutcomeSchema.safeParse(candidate)
  if (!parsed.success) return null
  const row = parsed.data as unknown as SettlementCompensationOutcome
  if (
    row.company_id !== companyId ||
    row.transaction_id !== transactionId ||
    row.original_journal_entry_id !== originalJournalEntryId ||
    row.publications[0].event_type !== 'journal_entry.committed' ||
    row.publications[0].event_key !==
      `journal:${row.reversal_journal_entry_id}:committed` ||
    row.publications[1].event_type !== 'journal_entry.reversed' ||
    row.publications[1].event_key !==
      `journal:${originalJournalEntryId}:reversed` ||
    row.publications[0].publication_id === row.publications[1].publication_id
  ) {
    return null
  }
  return row
}

function rpcRows(data: unknown): Record<string, unknown>[] {
  const values = Array.isArray(data) ? data : [data]
  return values.flatMap((value) => {
    const parsed = UnknownRpcObjectSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

function knownPublicationIds(data: unknown): string[] {
  const ids = new Set<string>()
  for (const row of rpcRows(data)) {
    const candidates = [
      row.publication,
      ...(Array.isArray(row.publications) ? row.publications : []),
    ]
    for (const candidate of candidates) {
      const parsed = UnknownRpcObjectSchema.safeParse(candidate)
      if (
        parsed.success &&
        typeof parsed.data.publication_id === 'string' &&
        parsed.data.publication_id.length > 0
      ) {
        ids.add(parsed.data.publication_id)
      }
    }
    if (Array.isArray(row.publication_ids)) {
      for (const id of row.publication_ids) {
        if (typeof id === 'string' && id.length > 0) ids.add(id)
      }
    }
  }
  return [...ids]
}

function addKnownJournalIds(
  postedIds: Record<string, string>,
  data: unknown,
  originalJournalEntryId: string,
): void {
  for (const row of rpcRows(data)) {
    if (
      typeof row.journal_entry_id === 'string' &&
      row.journal_entry_id !== originalJournalEntryId
    ) {
      postedIds.returned_journal_entry_id = row.journal_entry_id
    }
    if (
      typeof row.original_journal_entry_id === 'string' &&
      row.original_journal_entry_id !== originalJournalEntryId
    ) {
      postedIds.returned_original_journal_entry_id = row.original_journal_entry_id
    }
    if (typeof row.root_journal_entry_id === 'string') {
      postedIds.root_journal_entry_id = row.root_journal_entry_id
    }
    if (typeof row.reversal_journal_entry_id === 'string') {
      postedIds.reversal_journal_entry_id = row.reversal_journal_entry_id
    }
    const readback = UnknownRpcObjectSchema.safeParse(row.readback)
    const journal = readback.success
      ? UnknownRpcObjectSchema.safeParse(readback.data.journalEntry)
      : null
    const readbackJournal = journal?.success ? journal.data.id : null
    if (
      typeof readbackJournal === 'string' &&
      readbackJournal !== originalJournalEntryId
    ) {
      postedIds.readback_journal_entry_id = readbackJournal
    }
  }
}

async function invokeWithOneLostResponseRetry(
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation()
  } catch {
    try {
      return await operation()
    } catch {
      return null
    }
  }
}

export function createSettlementCoordinator(dependencies: SettlementCoordinatorDependencies) {
  return async function coordinate(input: {
    supabase: SupabaseClient
    companyId: string
    userId: string
    transaction: Transaction
    mappingResult: MappingResult
    category: TransactionCategory
    isBusiness: boolean
    settlementAccount: string
    notes?: string
    approvedSnapshot?: SettlementSnapshot
    existingCategorization?: boolean
  }): Promise<SettlementCoordinatorResult> {
    const currentSnapshot = stageSettlementSnapshot({
      companyId: input.companyId,
      transaction: input.transaction,
      mappingResult: input.mappingResult,
      category: input.category,
      isBusiness: input.isBusiness,
      settlementAccount: input.settlementAccount,
    })
    const snapshot = input.approvedSnapshot ?? currentSnapshot

    if (!snapshotsEqual(snapshot, currentSnapshot)) {
      return {
        kind: 'conflict',
        code: SETTLEMENT_SNAPSHOT_CONFLICT,
        message: 'Den godkända avräkningsbilden matchar inte längre transaktionen.',
        postedIds: {},
      }
    }

    if (snapshot.expectedJournalEntryId && input.existingCategorization !== false) {
      const existing = await dependencies.readback({
        supabase: input.supabase,
        snapshot,
        journalEntryId: snapshot.expectedJournalEntryId,
      })
      if (verifyReadback(existing, snapshot, snapshot.expectedJournalEntryId)) {
        return { kind: 'attached', created: false, readback: existing }
      }
      return {
        kind: 'conflict',
        code: SETTLEMENT_SNAPSHOT_CONFLICT,
        message: 'Den befintliga konteringen matchar inte den begärda avräkningen exakt.',
        postedIds: {},
      }
    }

    const posted = await dependencies.post({ ...input, snapshot })
    const originalJournalEntryId = posted.id
    const attachInput = {
      supabase: input.supabase,
      snapshot,
      userId: input.userId,
      journalEntryId: originalJournalEntryId,
    }
    const attachmentData = await invokeWithOneLostResponseRetry(
      () => dependencies.attach(attachInput),
    )
    const attachment = parseAttachmentOutcome(
      attachmentData,
      snapshot,
      originalJournalEntryId,
    )
    if (attachment) {
      return {
        kind: 'attached',
        created: true,
        readback: attachment.readback,
        publication: attachment.publication,
        journalEntry: posted,
      }
    }

    const compensationInput = {
      supabase: input.supabase,
      companyId: input.companyId,
      userId: input.userId,
      transactionId: input.transaction.id,
      originalJournalEntryId,
    }
    const compensationData = await invokeWithOneLostResponseRetry(
      () => dependencies.compensate(compensationInput),
    )
    const compensation = parseCompensationOutcome(
      compensationData,
      input.companyId,
      input.transaction.id,
      originalJournalEntryId,
    )
    const postedIds: Record<string, string> = {
      original_journal_entry_id: originalJournalEntryId,
    }
    addKnownJournalIds(postedIds, attachmentData, originalJournalEntryId)
    addKnownJournalIds(postedIds, compensationData, originalJournalEntryId)
    const publicationIds = [
      ...new Set([
        ...knownPublicationIds(attachmentData),
        ...knownPublicationIds(compensationData),
      ]),
    ]

    return {
      kind: 'partial',
      code: SETTLEMENT_ATTACHMENT_PARTIAL,
      message: compensation
        ? 'Konteringen kunde inte verifieras och kompenserades med en storno.'
        : 'Konteringen kunde inte verifieras och kompensationsutfallet är oklart.',
      postedIds,
      publicationIds,
    }
  }
}

async function readAuthoritativeSettlement(
  supabase: SupabaseClient,
  snapshot: SettlementSnapshot,
  journalEntryId: string,
): Promise<SettlementReadback | null> {
  const { data: transaction, error: transactionError } = await supabase
    .from('transactions')
    .select('id, company_id, journal_entry_id, cash_account_id, amount, amount_sek, currency, exchange_rate, category, is_business')
    .eq('id', snapshot.transactionId)
    .eq('company_id', snapshot.companyId)
    .maybeSingle()
  if (transactionError || !transaction) return null

  const { data: journalEntry, error: journalError } = await supabase
    .from('journal_entries')
    .select('id, company_id, status, source_type, source_id, categorization_category, categorization_is_business')
    .eq('id', journalEntryId)
    .eq('company_id', snapshot.companyId)
    .maybeSingle()
  if (journalError || !journalEntry) return null

  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, line_description, dimensions')
    .eq('journal_entry_id', journalEntryId)
  if (linesError || !lines) return null

  let cashAccount: SettlementReadback['cashAccount'] = null
  if (snapshot.cashAccountId) {
    const { data: cash, error: cashError } = await supabase
      .from('cash_accounts')
      .select('id, company_id, ledger_account')
      .eq('id', snapshot.cashAccountId)
      .eq('company_id', snapshot.companyId)
      .maybeSingle()
    if (cashError || !cash) return null
    cashAccount = {
      id: cash.id as string,
      companyId: cash.company_id as string,
      ledgerAccount: cash.ledger_account as string,
    }
  }

  const amountSek = resolveTransactionAmountSek(transaction as Transaction)
  if (amountSek === null) return null
  return {
    transaction: {
      id: transaction.id as string,
      companyId: transaction.company_id as string,
      journalEntryId: transaction.journal_entry_id as string,
      cashAccountId: (transaction.cash_account_id as string | null) ?? null,
      amountSek,
      category: transaction.category as TransactionCategory,
      isBusiness: transaction.is_business as boolean,
    },
    journalEntry: {
      id: journalEntry.id as string,
      companyId: journalEntry.company_id as string,
      status: journalEntry.status as string,
      sourceType: journalEntry.source_type as string,
      sourceId: (journalEntry.source_id as string | null) ?? null,
      category: (journalEntry.categorization_category as TransactionCategory | null) ?? null,
      isBusiness: (journalEntry.categorization_is_business as boolean | null) ?? null,
      lines: (lines as Array<{
        account_number: string
        debit_amount: number
        credit_amount: number
        line_description?: string | null
        dimensions?: unknown
      }>).map(normalizeLine),
    },
    cashAccount,
  }
}


const defaultDependencies: SettlementCoordinatorDependencies = {
  async post(input) {
    const fiscalPeriodId = await findFiscalPeriod(
      input.supabase,
      input.companyId,
      input.transaction.date,
    )
    if (!fiscalPeriodId) throw new Error('Ingen öppen räkenskapsperiod täcker transaktionsdatumet.')

    const engineInput = {
      fiscal_period_id: fiscalPeriodId,
      entry_date: input.transaction.date,
      description: input.notes?.trim()
        ? `${input.transaction.description} · ${input.notes.trim()}`.slice(0, 500)
        : input.transaction.description,
      source_type: 'bank_transaction',
      source_id: input.transaction.id,
      lines: buildTransactionEntryLines(input.transaction, input.mappingResult),
      categorization_category: input.snapshot.category,
      categorization_is_business: input.snapshot.isBusiness,
    } as CreateJournalEntryInput & {
      categorization_category: TransactionCategory
      categorization_is_business: boolean
    }
    const draft = await createDraftEntry(
      input.supabase,
      input.companyId,
      input.userId,
      engineInput,
    )
    const entry = await commitEntry(
      input.supabase,
      input.companyId,
      input.userId,
      draft.id,
      undefined,
      undefined,
      { emitCommittedEvent: false },
    )
    return entry
  },
  async attach({ supabase, snapshot, journalEntryId, userId }) {
    const { data, error } = await supabase.rpc('attach_transaction_categorization', {
      p_company_id: snapshot.companyId,
      p_transaction_id: snapshot.transactionId,
      p_journal_entry_id: journalEntryId,
      p_user_id: userId,
      p_expected_journal_entry_id: snapshot.expectedJournalEntryId,
      p_expected_cash_account_id: snapshot.cashAccountId,
      p_expected_settlement_account: snapshot.settlementAccount,
      p_expected_amount_sek: snapshot.amountSek,
      p_expected_category: snapshot.category,
      p_expected_is_business: snapshot.isBusiness,
      p_expected_lines: snapshot.lines,
    })
    if (error) throw error
    return data
  },
  async readback({ supabase, snapshot, journalEntryId }) {
    return readAuthoritativeSettlement(supabase, snapshot, journalEntryId)
  },
  async compensate({ supabase, companyId, userId, transactionId, originalJournalEntryId }) {
    const { data, error } = await supabase.rpc('compensate_transaction_categorization', {
      p_company_id: companyId,
      p_transaction_id: transactionId,
      p_original_journal_entry_id: originalJournalEntryId,
      p_actor_type: 'user',
      p_actor_id: userId,
      p_actor_label: null,
    })
    if (error) throw error
    return data
  },
}

export const coordinateTransactionSettlement = createSettlementCoordinator(defaultDependencies)

export type SettlementJournalEntry = Pick<JournalEntry, 'id'>
