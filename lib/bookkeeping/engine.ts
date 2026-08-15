import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import {
  AccountsNotInChartError,
  AmbiguousJournalCommitError,
  BookkeepingDatabaseError,
  DurableAccountingConflictError,
  DurableAccountingIdentityError,
  DurableAccountingPartialError,
  CannotEditNonDraftError,
  CannotReverseNonPostedError,
  CannotReverseStornoError,
  CorrectionChainTooDeepError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
} from '@/lib/bookkeeping/errors'
import {
  correctionChainDepth,
  CORRECTION_CHAIN_GUARD_DEPTH,
} from '@/lib/core/bookkeeping/correction-chain'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  normalizeLineDimensions,
  validateEntryDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  assertMandatoryDimensions,
  fetchActiveDimensionRules,
  isDimensionRuleExemptSource,
  isDimensionValidationExemptSource,
} from '@/lib/bookkeeping/dimension-rules'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import {
  applySupplierPaymentReversal,
  isPaymentSourceType,
  resolveSupplierPaymentLineage,
  syncInvoiceStatusFromPaymentEntry,
} from '@/lib/bookkeeping/payment-sync'
import { getActor } from '@/lib/bookkeeping/actor-context'
import type {
  AccountingActor,
  AccountingActorType,
  AssetDisposalType,
  AssetJamkningDirection,
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  DurableCategorizationCompensationOutcome,
  DurableJournalReversalOutcome,
  DurablePublicationIdentity,
  JournalEntry,
  JournalEntryLine,
  JournalEntrySourceType,
  VatTreatment,
} from '@/types'

const log = createLogger('bookkeeping.engine')

/**
 * Validate that a set of journal entry lines is balanced (debits = credits)
 */
export function validateBalance(lines: CreateJournalEntryLineInput[]): {
  valid: boolean
  totalDebit: number
  totalCredit: number
} {
  const totalDebit = lines.reduce((sum, l) => sum + (l.debit_amount || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (l.credit_amount || 0), 0)

  // Round to avoid floating point issues (2 decimal places for SEK)
  const roundedDebit = Math.round(totalDebit * 100) / 100
  const roundedCredit = Math.round(totalCredit * 100) / 100

  return {
    valid: roundedDebit === roundedCredit && roundedDebit > 0,
    totalDebit: roundedDebit,
    totalCredit: roundedCredit,
  }
}

/**
 * Get the next voucher number for a company/period/series
 * Uses the concurrent-safe INSERT ON CONFLICT implementation in the database
 */
export async function getNextVoucherNumber(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  series: string = 'A'
): Promise<number> {

  const { data, error } = await supabase.rpc('next_voucher_number', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_series: series,
  })

  if (error) {
    throw new BookkeepingDatabaseError('get_next_voucher_number', error.message)
  }

  return data as number
}

/**
 * Resolve account IDs from account numbers for a company.
 *
 * By default only active accounts are returned: inactive / never-added
 * accounts surface as "missing" so callers throw AccountsNotInChartError.
 *
 * Pass `{ includeInactive: true }` for reversals: the accounts on an already-
 * committed entry were legitimately active at commit time, and BFL 5 kap 5§
 * requires storno to be possible even if a user has since deactivated one of
 * those accounts. Blocking the reversal would leave the original entry
 * uncorrected with no audit trail.
 */
async function resolveAccountIds(
  supabase: SupabaseClient,
  companyId: string,
  lines: CreateJournalEntryLineInput[],
  options: { includeInactive?: boolean } = {}
): Promise<Map<string, string>> {
  const accountNumbers = [...new Set(lines.map((l) => l.account_number))]

  let query = supabase
    .from('chart_of_accounts')
    .select('id, account_number')
    .eq('company_id', companyId)
    .in('account_number', accountNumbers)

  if (!options.includeInactive) {
    query = query.eq('is_active', true)
  }

  const { data: accounts, error } = await query

  if (error) {
    throw new BookkeepingDatabaseError('resolve_account_ids', error.message)
  }

  const map = new Map<string, string>()
  for (const account of accounts || []) {
    map.set(account.account_number, account.id)
  }

  return map
}

/**
 * Resolve the default voucher_series for a given source_type from
 * company_settings.default_voucher_series_per_source_type. Falls back to 'A'
 * silently when the column isn't present (e.g. older DB snapshot in a test),
 * the lookup fails, or the configured value is invalid.
 *
 * Only called when the caller of createDraftEntry omitted voucher_series.
 * Explicit voucher_series in the input always wins.
 */
async function resolveSeriesFromSettings(
  supabase: SupabaseClient,
  companyId: string,
  sourceType: JournalEntrySourceType,
): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('company_settings')
      .select('default_voucher_series_per_source_type')
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) return 'A'
    return resolveDefaultSeriesForSource(
      data as { default_voucher_series_per_source_type?: Record<string, string> | null } | null,
      sourceType,
    )
  } catch {
    return 'A'
  }
}

/**
 * Find the fiscal period for a given date
 */
export async function findFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  date: string
): Promise<string | null> {

  // Overlapping periods are prevented by a DB exclusion constraint
  // (migration 042). limit(1) is kept as a defensive measure.
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .order('period_start', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0) {
    return null
  }

  return data[0].id
}

/**
 * Build line insert objects from input lines, resolving account IDs and
 * including tax_code and the dimensions bag
 */
function buildLineValues(
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return lines.map((line, index) => {
    // dimensions JSONB is the single source of truth; cost_center/project
    // are GENERATED columns derived from keys '1'/'6' since the PR9 cutover
    // (20260702230000): writing them explicitly would error.
    const dimensions = normalizeLineDimensions(line)
    return {
      account_number: line.account_number,
      account_id: accountIdMap.get(line.account_number) || null,
      debit_amount: Math.round((line.debit_amount || 0) * 100) / 100,
      credit_amount: Math.round((line.credit_amount || 0) * 100) / 100,
      currency: line.currency || 'SEK',
      amount_in_currency: line.amount_in_currency ? Math.round(line.amount_in_currency * 100) / 100 : null,
      exchange_rate: line.exchange_rate || null,
      line_description: line.line_description || null,
      tax_code: line.tax_code || null,
      dimensions,
      sort_order: index,
    }
  })
}

function buildLineInserts(
  entryId: string,
  lines: CreateJournalEntryLineInput[],
  accountIdMap: Map<string, string>
) {
  return buildLineValues(lines, accountIdMap).map((line) => ({
    journal_entry_id: entryId,
    ...line,
  }))
}

/**
 * Create a draft journal entry with lines (no voucher number assigned yet)
 * The entry stays in 'draft' status until commitEntry() is called.
 */
export async function createDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput
): Promise<JournalEntry> {
  // Validate balance
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Account dimension rules (dimensions PR10): apply 'default'/'fixed'
  // values onto the line bags before validation + insert. Zero rules —
  // every company by default — returns the input untouched; a failed rule
  // fetch fails open like the soft validation below. System-generated and
  // correction sources are exempt — policy governs new business events,
  // never imported history or bokslut mechanics.
  const ruleExempt = isDimensionRuleExemptSource(input.source_type)
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed — defaults/fixed skipped (fail-open)', { companyId })
  }
  const lines = rules ? applyDimensionRules(input.lines, rules) : input.lines

  // Soft dimension validation (dimensions plan PR3): free for untagged
  // entries; free-text passthrough unless company_settings.dimensions_enabled;
  // enabled companies get registry validation with a typed Swedish rejection.
  // Runs before any insert so a rejection leaves no orphan rows. Reversal/
  // storno/correction paths bypass this: they copy posted data verbatim.
  // Accrual dissolutions bypass it for exactly that reason too: they replay
  // the origin entry's bag, so a value archived after the origin was posted
  // must not be able to strand the remaining months as pending and leave the
  // interim 17xx/29xx account overstated. See
  // DIMENSION_VALIDATION_EXEMPT_SOURCE_TYPES.
  if (!isDimensionValidationExemptSource(input.source_type)) {
    await validateEntryDimensions(supabase, companyId, lines)
  }

  // Validate that entry_date falls within the selected fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', input.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new FiscalPeriodNotFoundError()
  }

  if (input.entry_date < period.period_start || input.entry_date > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(
      input.entry_date,
      period.name,
      period.period_start,
      period.period_end
    )
  }

  // Resolve account IDs
  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)

  // Validate all account numbers resolved to IDs. Standard BAS accounts are
  // seeded on demand before failing: a minimal chart routinely lacks accounts
  // legitimate flows reach (3740 öresavrundning on the first sub-krona
  // Bankgiro diff, 6580 on a first legal invoice), and throwing here turned
  // those into dead ends. Non-BAS numbers and deliberately deactivated
  // accounts still throw.
  const allAccountNumbers = [...new Set(input.lines.map(l => l.account_number))]
  let missingAccounts = allAccountNumbers.filter(num => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [num, id] of refreshed) accountIdMap.set(num, id)
      missingAccounts = allAccountNumbers.filter(num => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  // Resolve voucher_series: explicit input wins; otherwise look up the
  // per-source-type default from company_settings (falls back to 'A').
  const resolvedSeries = input.voucher_series
    ? input.voucher_series
    : await resolveSeriesFromSettings(supabase, companyId, input.source_type)

  // Insert journal entry header as draft (voucher_number = 0, will be assigned on commit)
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: input.fiscal_period_id,
      voucher_number: 0,
      voucher_series: resolvedSeries,
      entry_date: input.entry_date,
      description: input.description,
      source_type: input.source_type,
      source_id: input.source_id || null,
      categorization_category: input.categorization_category ?? null,
      categorization_is_business: input.categorization_is_business ?? null,
      notes: input.notes || null,
      status: 'draft',
    })
    .select()
    .single()

  if (entryError || !entry) {
    log.error('insert journal_entries draft failed', entryError ?? new Error('no row returned'), {
      operation: 'create_draft_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      fiscalPeriodId: input.fiscal_period_id,
      sourceType: input.source_type,
      pgCode: (entryError as { code?: string } | null)?.code,
      pgDetails: (entryError as { details?: string } | null)?.details,
      pgHint: (entryError as { hint?: string } | null)?.hint,
    })
    throw new BookkeepingDatabaseError('create_draft_entry', entryError?.message)
  }

  // Insert journal entry lines with dimensions
  const lineInserts = buildLineInserts(entry.id, lines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    log.error('insert journal_entry_lines failed', linesError, {
      operation: 'create_entry_lines',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entry.id,
      lineCount: lineInserts.length,
      pgCode: (linesError as { code?: string }).code,
      pgDetails: (linesError as { details?: string }).details,
      pgHint: (linesError as { hint?: string }).hint,
    })
    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', entry.id)
    if (cancelError) {
      log.error('orphan draft cleanup failed (phantom draft remains)', cancelError, {
        operation: 'create_entry_lines.cleanup',
        companyId,
        entityType: 'journal_entry',
        entityId: entry.id,
        pgCode: (cancelError as { code?: string }).code,
      })
    }
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message)
  }

  // Fetch complete entry with lines
  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entry.id)
    .single()

  const result = completeEntry as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.drafted',
    payload: { entry: result, userId, companyId },
  })

  return result
}

/**
 * Update an existing DRAFT journal entry in place: header + lines. Only drafts
 * are editable; committed entries (posted/reversed/cancelled) are immutable per
 * BFL 5 kap. and rejected with CannotEditNonDraftError (the DB immutability
 * trigger is the backstop). Mirrors createDraftEntry's validate-everything-first
 * order so an unbalanced set, a bad period, or a locked period fails before any
 * row is mutated: the header UPDATE is the first write, so a locked period
 * aborts cleanly with the draft untouched.
 */
export async function updateDraftEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  input: CreateJournalEntryInput
): Promise<JournalEntry> {
  // Load the entry and assert it is an editable draft.
  const { data: existing, error: loadError } = await supabase
    .from('journal_entries')
    .select('id, status, voucher_series')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()

  if (loadError || !existing) {
    throw new JournalEntryNotFoundError()
  }
  if (existing.status !== 'draft') {
    throw new CannotEditNonDraftError(existing.status as string)
  }

  // Same balance gate as createDraftEntry.
  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'draft')
  }

  // Same soft dimension validation as createDraftEntry: before any write, so
  // a rejection leaves both the header and the existing lines untouched.
  // Account dimension rules (PR10) apply first — same as create. Gate on
  // the STORED source_type (updates preserve it; the input's copy is not
  // authoritative here).
  const ruleExempt = isDimensionRuleExemptSource(
    (existing as { source_type?: string }).source_type
  )
  const rules = ruleExempt ? [] : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed — defaults/fixed skipped (fail-open)', { companyId })
  }
  const lines = rules ? applyDimensionRules(input.lines, rules) : input.lines
  await validateEntryDimensions(supabase, companyId, lines)

  // Entry date must fall within the selected fiscal period.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', input.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new FiscalPeriodNotFoundError()
  }
  if (input.entry_date < period.period_start || input.entry_date > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(
      input.entry_date,
      period.name,
      period.period_start,
      period.period_end
    )
  }

  // Resolve account IDs (seeding standard BAS accounts on demand) up front, so
  // the line insert below cannot fail on a missing account: same as create.
  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)
  const allAccountNumbers = [...new Set(input.lines.map((l) => l.account_number))]
  let missingAccounts = allAccountNumbers.filter((num) => !accountIdMap.has(num))
  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(supabase, companyId, userId, missingAccounts)
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [num, id] of refreshed) accountIdMap.set(num, id)
      missingAccounts = allAccountNumbers.filter((num) => !accountIdMap.has(num))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  const resolvedSeries = input.voucher_series || (existing.voucher_series as string) || 'A'

  // All validation passed: mutate. Update the header first; a locked/closed
  // period blocks this write (enforce_period_lock) before any line is touched.
  // source_type / source_id / status are intentionally preserved.
  const { error: headerError } = await supabase
    .from('journal_entries')
    .update({
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.entry_date,
      description: input.description,
      voucher_series: resolvedSeries,
      notes: input.notes || null,
      categorization_category: input.categorization_category ?? null,
      categorization_is_business: input.categorization_is_business ?? null,
    })
    .eq('id', entryId)
    .eq('company_id', companyId)

  if (headerError) {
    throw new BookkeepingDatabaseError('create_draft_entry', headerError.message)
  }

  // Replace the lines: delete the old set, insert the new one.
  const { error: deleteError } = await supabase
    .from('journal_entry_lines')
    .delete()
    .eq('journal_entry_id', entryId)

  if (deleteError) {
    throw new BookkeepingDatabaseError('create_entry_lines', deleteError.message)
  }

  const lineInserts = buildLineInserts(entryId, lines, accountIdMap)
  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    log.error('update draft: insert journal_entry_lines failed', linesError, {
      operation: 'create_entry_lines',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      lineCount: lineInserts.length,
      pgCode: (linesError as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('create_entry_lines', linesError.message)
  }

  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .single()

  return completeEntry as JournalEntry
}

/**
 * Commit a draft entry: assigns voucher number and transitions to 'posted'
 * Uses the atomic commit_journal_entry RPC so the voucher number increment
 * and status update happen in one transaction. If the balance trigger rejects
 * the entry, the sequence increment rolls back: no burned numbers.
 *
 * Actor attribution: the surrounding runWithActor() scope (set by the
 * approval entry points: commitPendingOperation, web approve routes) is
 * forwarded to the RPC, which stamps journal_entries.committed_actor_* and
 * the audit_log COMMIT row (migration 20260619120000). No scope → NULLs,
 * identical to pre-attribution behaviour.
 */
export interface CommitEntryOptions {
  emitCommittedEvent?: boolean
}

function rpcVoucherNumber(data: unknown): number | null {
  const value = Array.isArray(data) ? data[0] : data
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const voucherNumber = (value as Record<string, unknown>).voucher_number
  return typeof voucherNumber === 'number' && Number.isFinite(voucherNumber)
    ? voucherNumber
    : null
}

async function readCompleteJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<{ entry: JournalEntry | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .single()
    return {
      entry: data ? data as JournalEntry : null,
      error: error?.message ?? (data ? null : 'journal entry was not returned'),
    }
  } catch (error) {
    return {
      entry: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
export async function commitEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  commitMethod?: string,
  rubricVersion?: string,
  options: CommitEntryOptions = {},
): Promise<JournalEntry> {
  const actor = getActor()

  // Mandatory dimension rules (dimensions PR10): 'required' rules bite when
  // the verifikat is about to become immutable. Reversal/correction paths do
  // not pass through commitEntry, so history always remains reversible.
  const rules = await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    log.warn('dimension rule fetch failed: mandatory enforcement skipped (fail-open)', {
      companyId,
      entityId: entryId,
    })
  } else if (rules.some((rule) => rule.rule_type === 'required')) {
    type RuleLine = {
      account_number: string
      dimensions: Record<string, string>
      journal_entries: { source_type: string }
    }
    let typedLines: RuleLine[] | null = null
    try {
      typedLines = await fetchEntryLines<RuleLine>({
        supabase,
        entryColumns: 'source_type',
        lineColumns: 'account_number, dimensions',
        filterEntries: (query: EntryLinesQuery) =>
          query.eq('id', entryId).eq('company_id', companyId),
      })
    } catch {
      typedLines = null
    }
    if (!typedLines) {
      log.warn('line fetch for mandatory dimension check failed: enforcement skipped (fail-open)', {
        companyId,
        entityId: entryId,
      })
    } else if (!isDimensionRuleExemptSource(typedLines[0]?.journal_entries?.source_type)) {
      assertMandatoryDimensions(typedLines, rules)
    }
  }

  let rpcResult: unknown = null
  let commitError: { message: string; code?: string; details?: string; hint?: string } | null = null
  try {
    const response = await supabase.rpc('commit_journal_entry', {
      p_company_id: companyId,
      p_entry_id: entryId,
      p_commit_method: commitMethod ?? null,
      p_rubric_version: rubricVersion ?? null,
      p_actor_type: actor?.type ?? null,
      p_actor_label: actor?.label ?? null,
    })
    rpcResult = response.data
    commitError = response.error
  } catch (error) {
    commitError = {
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const readback = await readCompleteJournalEntry(supabase, companyId, entryId)
  if (commitError) {
    log.error('commit_journal_entry RPC failed', commitError, {
      operation: 'commit_entry',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: entryId,
      commitMethod: commitMethod ?? null,
      pgCode: commitError.code,
      pgDetails: commitError.details,
      pgHint: commitError.hint,
    })
    if (
      readback.entry?.status === 'draft' &&
      readback.entry.voucher_number === 0
    ) {
      throw new BookkeepingDatabaseError('commit_entry', commitError.message)
    }
    if (readback.entry?.status !== 'posted') {
      throw new AmbiguousJournalCommitError(
        entryId,
        readback.entry?.voucher_number || rpcVoucherNumber(rpcResult),
        readback.error ?? commitError.message,
      )
    }
  }

  if (!readback.entry || readback.entry.status !== 'posted') {
    throw new AmbiguousJournalCommitError(
      entryId,
      readback.entry?.voucher_number || rpcVoucherNumber(rpcResult),
      readback.error ?? `unexpected durable status ${readback.entry?.status ?? 'missing'}`,
    )
  }

  if (options.emitCommittedEvent !== false) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: readback.entry, userId, companyId },
    })
  }
  return readback.entry
}

export interface CommitAssetDisposalInput {
  asset_id: string
  expected_asset_updated_at: string
  fiscal_period_id: string
  disposal_type: AssetDisposalType
  disposed_at: string
  disposed_proceeds: number
  proceeds_vat: number
  vat_treatment: VatTreatment | null
  current_depreciation: number
  jamkning_amount: number
  jamkning_direction: AssetJamkningDirection
  jamkning_remaining_years: number | null
  jamkning_total_years: number | null
  jamkning_original_input_vat: number | null
  jamkning_original_deduction_percent: number | null
  jamkning_new_deduction_percent: number | null
}

/**
 * Commit a prepared asset-disposal draft and update the asset register in the
 * same database transaction. The dedicated RPC delegates voucher numbering to
 * commit_journal_entry, so disposal cannot leave a posted voucher without the
 * corresponding immutable register state.
 */
export async function commitAssetDisposal(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string | null,
  input: CommitAssetDisposalInput,
): Promise<JournalEntry | null> {
  const actor = getActor()
  const { data: rpcResult, error } = await supabase.rpc('commit_asset_disposal', {
    p_company_id: companyId,
    p_asset_id: input.asset_id,
    p_entry_id: entryId,
    p_expected_asset_updated_at: input.expected_asset_updated_at,
    p_fiscal_period_id: input.fiscal_period_id,
    p_disposal_type: input.disposal_type,
    p_disposed_at: input.disposed_at,
    p_disposed_proceeds: input.disposed_proceeds,
    p_proceeds_vat: input.proceeds_vat,
    p_vat_treatment: input.vat_treatment,
    p_current_depreciation: input.current_depreciation,
    p_jamkning_amount: input.jamkning_amount,
    p_jamkning_direction: input.jamkning_direction,
    p_jamkning_remaining_years: input.jamkning_remaining_years,
    p_jamkning_total_years: input.jamkning_total_years,
    p_jamkning_original_input_vat: input.jamkning_original_input_vat,
    p_jamkning_original_deduction_percent: input.jamkning_original_deduction_percent,
    p_jamkning_new_deduction_percent: input.jamkning_new_deduction_percent,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    log.error('commit_asset_disposal RPC failed', error, {
      operation: 'commit_asset_disposal',
      companyId,
      userId,
      entityType: 'asset',
      entityId: input.asset_id,
      journalEntryId: entryId,
      pgCode: (error as { code?: string }).code,
    })
    throw new BookkeepingDatabaseError('commit_asset_disposal', error.message)
  }

  if (!entryId) return null

  // The RPC has already committed the voucher and the register update at this
  // point. A transient reload failure must not masquerade as a failed
  // disposal, so retry once and log the divergence before surfacing it.
  let completeEntry: JournalEntry | null = null
  let lastFetchError: { message: string } | null = null
  for (let attempt = 0; attempt < 2 && !completeEntry; attempt++) {
    const { data, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', entryId)
      .eq('company_id', companyId)
      .single()
    if (data && !fetchError) {
      completeEntry = data as JournalEntry
    } else {
      lastFetchError = fetchError ?? { message: 'posted entry not found' }
    }
  }

  if (!completeEntry) {
    log.error(
      'asset disposal committed but posted entry reload failed',
      lastFetchError,
      {
        operation: 'commit_asset_disposal',
        companyId,
        userId,
        entityType: 'asset',
        entityId: input.asset_id,
        journalEntryId: entryId,
      },
    )
    throw new AmbiguousJournalCommitError(
      entryId,
      rpcVoucherNumber(rpcResult),
      lastFetchError?.message ?? 'posted entry not found',
    )
  }

  const result = completeEntry
  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: result, userId, companyId },
  })
  return result
}

/**
 * Create a journal entry with lines (verifikation)
 * Convenience wrapper: creates draft + commits in one step.
 * The voucher number is only assigned after lines are successfully inserted,
 * preventing gaps in the voucher sequence (BFL 5 kap. 7§).
 *
 * If commitEntry fails (e.g. balance trigger rejection, period lock, RPC error),
 * the orphan draft is cancelled so callers don't leave an undeletable stuck draft.
 * The commit RPC is atomic: no voucher number is burned on failure.
 */
export async function createJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateJournalEntryInput,
  commitMethod?: string,
  rubricVersion?: string,
  options: CommitEntryOptions = {},
): Promise<JournalEntry> {
  const draft = await createDraftEntry(supabase, companyId, userId, input)
  try {
    return await commitEntry(
      supabase,
      companyId,
      userId,
      draft.id,
      commitMethod,
      rubricVersion,
      options,
    )
  } catch (commitError) {
    if (commitError instanceof AmbiguousJournalCommitError) throw commitError
    try {
      const { error: cancelError } = await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', draft.id)
        .eq('company_id', companyId)
        .eq('status', 'draft')
      if (cancelError) {
        log.error('orphan draft cleanup failed (phantom draft remains)', cancelError, {
          operation: 'create_journal_entry.cleanup',
          companyId,
          entityType: 'journal_entry',
          entityId: draft.id,
          pgCode: (cancelError as { code?: string }).code,
        })
      }
    } catch (cleanupError) {
      log.error('orphan draft cleanup threw (phantom draft remains)', cleanupError as Error, {
        operation: 'create_journal_entry.cleanup',
        companyId,
        entityType: 'journal_entry',
        entityId: draft.id,
      })
    }
    throw commitError
  }
}

export interface OpeningBalanceReplacementResult {
  newEntryId: string
  stornoEntryId: string
  newVoucherNumber: number
  stornoVoucherNumber: number
}

/**
 * Atomically replace a period's posted opening balance with a new engine
 * voucher and a storno of the old voucher. The database function owns the
 * period row lock, authorization, compare-and-swap check, voucher commits,
 * status transition, and pointer swap in one transaction.
 */
export async function replaceOpeningBalanceEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  expectedOldEntryId: string,
  input: CreateJournalEntryInput,
): Promise<OpeningBalanceReplacementResult> {
  if (input.source_type !== 'opening_balance') {
    throw new BookkeepingDatabaseError(
      'replace_opening_balance',
      'Replacement entry must use source_type opening_balance',
    )
  }

  const balance = validateBalance(input.lines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(
      balance.totalDebit,
      balance.totalCredit,
      'draft',
    )
  }

  await validateEntryDimensions(supabase, companyId, input.lines)

  const accountIdMap = await resolveAccountIds(supabase, companyId, input.lines)
  const accountNumbers = [...new Set(input.lines.map((line) => line.account_number))]
  let missingAccounts = accountNumbers.filter((number) => !accountIdMap.has(number))

  if (missingAccounts.length > 0) {
    const seeded = await backfillStandardBASAccounts(
      supabase,
      companyId,
      userId,
      missingAccounts,
    )
    if (seeded.length > 0) {
      const refreshed = await resolveAccountIds(supabase, companyId, input.lines)
      for (const [number, id] of refreshed) accountIdMap.set(number, id)
      missingAccounts = accountNumbers.filter((number) => !accountIdMap.has(number))
    }
    if (missingAccounts.length > 0) {
      throw new AccountsNotInChartError(missingAccounts)
    }
  }

  const voucherSeries = input.voucher_series
    ?? await resolveSeriesFromSettings(supabase, companyId, 'opening_balance')
  const preparedLines = buildLineValues(input.lines, accountIdMap)
  const actor = getActor()

  const { data, error } = await supabase.rpc('commit_opening_balance_replacement', {
    p_company_id: companyId,
    p_period_id: input.fiscal_period_id,
    p_expected_old_entry_id: expectedOldEntryId,
    p_user_id: userId,
    p_entry_date: input.entry_date,
    p_description: input.description,
    p_voucher_series: voucherSeries,
    p_lines: preparedLines,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })

  if (error) {
    log.error('commit_opening_balance_replacement RPC failed', error, {
      operation: 'replace_opening_balance',
      companyId,
      userId,
      entityType: 'journal_entry',
      entityId: expectedOldEntryId,
      fiscalPeriodId: input.fiscal_period_id,
      pgCode: (error as { code?: string }).code,
      pgDetails: (error as { details?: string }).details,
      pgHint: (error as { hint?: string }).hint,
    })
    throw new BookkeepingDatabaseError('replace_opening_balance', error.message)
  }

  type RpcRow = {
    new_entry_id: string
    storno_entry_id: string
    new_voucher_number: number
    storno_voucher_number: number
  }
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null
  if (!row?.new_entry_id || !row.storno_entry_id) {
    throw new BookkeepingDatabaseError(
      'replace_opening_balance',
      'Atomic replacement returned no journal entry ids',
    )
  }

  const result: OpeningBalanceReplacementResult = {
    newEntryId: row.new_entry_id,
    stornoEntryId: row.storno_entry_id,
    newVoucherNumber: row.new_voucher_number,
    stornoVoucherNumber: row.storno_voucher_number,
  }

  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('company_id', companyId)
    .in('id', [expectedOldEntryId, result.newEntryId, result.stornoEntryId])

  if (entriesError) {
    log.error('atomic opening balance replacement committed but entry refresh failed', entriesError, {
      companyId,
      entityId: result.newEntryId,
    })
    return result
  }

  const byId = new Map(
    ((entries ?? []) as JournalEntry[]).map((entry) => [entry.id, entry]),
  )
  const originalEntry = byId.get(expectedOldEntryId)
  const newEntry = byId.get(result.newEntryId)
  const stornoEntry = byId.get(result.stornoEntryId)

  if (!originalEntry || !newEntry || !stornoEntry) {
    log.error(
      'atomic opening balance replacement committed but event entries are missing',
      new Error('journal entry refresh returned incomplete replacement data'),
      {
        companyId,
        expectedOldEntryId,
        newEntryId: result.newEntryId,
        stornoEntryId: result.stornoEntryId,
        missingOriginalEntry: !originalEntry,
        missingNewEntry: !newEntry,
        missingStornoEntry: !stornoEntry,
      },
    )
  }

  if (newEntry) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: newEntry, userId, companyId },
    })
  }
  if (stornoEntry) {
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: stornoEntry, userId, companyId },
    })
  }
  if (originalEntry && stornoEntry) {
    await eventBus.emit({
      type: 'journal_entry.reversed',
      payload: { originalEntry, reversalEntry: stornoEntry, userId, companyId },
    })
  }

  return result
}

/**
 * Get the current date in Swedish timezone (Europe/Stockholm).
 * Avoids UTC date shift when server runs in a different timezone.
 */
export function getSwedishLocalDate(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

function accountingActor(
  userId: string,
  explicit: AccountingActor | undefined,
): AccountingActor {
  if (explicit) return explicit
  const ambient = getActor()
  if (ambient) {
    return {
      actor_type: ambient.type,
      actor_id: ambient.type === 'user' ? userId : null,
      actor_label: ambient.label ?? null,
    }
  }
  return {
    actor_type: 'user',
    actor_id: userId,
    actor_label: null,
  }
}

function publicationMarker(publication: DurablePublicationIdentity) {
  return {
    persisted: true as const,
    publication_id: publication.publication_id,
    event_key: publication.event_key,
  }
}

async function hydrateDurableReversal(
  supabase: SupabaseClient,
  outcome: DurableJournalReversalOutcome,
): Promise<{ original: JournalEntry; reversal: JournalEntry }> {
  const [originalReadback, reversalReadback] = await Promise.all([
    readCompleteJournalEntry(
      supabase,
      outcome.company_id,
      outcome.original_journal_entry_id,
    ),
    readCompleteJournalEntry(
      supabase,
      outcome.company_id,
      outcome.reversal_journal_entry_id,
    ),
  ])
  const original = originalReadback.entry
  const reversal = reversalReadback.entry
  if (
    !original ||
    !reversal ||
    original.status !== 'reversed' ||
    original.reversed_by_id !== outcome.reversal_journal_entry_id ||
    reversal.status !== 'posted' ||
    reversal.source_type !== 'storno' ||
    reversal.reverses_id !== outcome.original_journal_entry_id
  ) {
    throw new DurableAccountingIdentityError(
      'verify_durable_accounting_identity',
      {
        company_id: outcome.company_id,
        original_journal_entry_id: outcome.original_journal_entry_id,
        reversal_journal_entry_id: outcome.reversal_journal_entry_id,
        publication_ids: outcome.publications.map(
          (publication) => publication.publication_id,
        ),
      },
      originalReadback.error ??
        reversalReadback.error ??
        'journal readback did not match the exact original and storno links',
    )
  }
  return { original, reversal }
}

async function emitDurableReversalEvents(
  outcome: DurableJournalReversalOutcome,
  entries: { original: JournalEntry; reversal: JournalEntry },
  userId: string,
): Promise<void> {
  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: {
      entry: entries.reversal,
      userId,
      companyId: outcome.company_id,
      durablePublication: publicationMarker(outcome.publications[0]),
    },
  })
  await eventBus.emit({
    type: 'journal_entry.reversed',
    payload: {
      originalEntry: entries.original,
      reversalEntry: entries.reversal,
      userId,
      companyId: outcome.company_id,
      durablePublication: publicationMarker(outcome.publications[1]),
    },
  })
}

function durableRpcRow(data: unknown): Record<string, unknown> | null {
  const value = Array.isArray(data) ? data[0] : data
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

const ACCOUNTING_ACTOR_TYPE: Record<AccountingActorType, true> = {
  user: true,
  api_key: true,
  mcp_oauth: true,
  cron: true,
  system: true,
  agent_chat: true,
}

function isAccountingActorType(value: unknown): value is AccountingActorType {
  return typeof value === 'string' && value in ACCOUNTING_ACTOR_TYPE
}

function isDurablePublicationIdentity(
  value: unknown,
): value is DurablePublicationIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const publication = value as Record<string, unknown>
  return (
    typeof publication.publication_id === 'string' &&
    publication.publication_id.length > 0 &&
    typeof publication.event_key === 'string' &&
    publication.event_key.length > 0 &&
    (
      publication.event_type === 'journal_entry.committed' ||
      publication.event_type === 'journal_entry.reversed'
    )
  )
}

function parseCategorizationCompensation(
  data: unknown,
  companyId: string,
  transactionId: string,
  originalJournalEntryId: string,
): DurableCategorizationCompensationOutcome | null {
  const row = durableRpcRow(data)
  if (
    !row ||
    (row.status !== 'applied' && row.status !== 'already_applied') ||
    row.company_id !== companyId ||
    row.transaction_id !== transactionId ||
    typeof row.root_journal_entry_id !== 'string' ||
    row.original_journal_entry_id !== originalJournalEntryId ||
    typeof row.reversal_journal_entry_id !== 'string' ||
    row.reversal_journal_entry_id.length === 0 ||
    !isAccountingActorType(row.actor_type) ||
    (row.actor_id !== null && typeof row.actor_id !== 'string') ||
    (row.actor_label !== null && typeof row.actor_label !== 'string') ||
    !Array.isArray(row.publications) ||
    row.publications.length !== 2 ||
    !row.publications.every(isDurablePublicationIdentity)
  ) {
    return null
  }
  const publications = row.publications as DurablePublicationIdentity[]
  if (
    publications[0]!.event_type !== 'journal_entry.committed' ||
    publications[1]!.event_type !== 'journal_entry.reversed' ||
    publications[0]!.publication_id === publications[1]!.publication_id ||
    publications[0]!.event_key === publications[1]!.event_key
  ) {
    return null
  }
  return row as unknown as DurableCategorizationCompensationOutcome
}

export async function compensateTransactionCategorization(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    transactionId: string
    originalJournalEntryId: string
    actor?: AccountingActor
  },
): Promise<{
  outcome: DurableCategorizationCompensationOutcome
  originalEntry: JournalEntry
  reversalEntry: JournalEntry
}> {
  const actor = accountingActor(params.userId, params.actor)
  const rpcArgs = {
    p_company_id: params.companyId,
    p_transaction_id: params.transactionId,
    p_original_journal_entry_id: params.originalJournalEntryId,
    p_actor_type: actor.actor_type,
    p_actor_id: actor.actor_id,
    p_actor_label: actor.actor_label,
  }
  let data: unknown = null
  let lastError: { message: string } | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await supabase.rpc(
        'compensate_transaction_categorization',
        rpcArgs,
      )
      data = response.data
      lastError = response.error
    } catch (error) {
      lastError = {
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (!lastError) break
  }
  if (lastError) {
    throw new DurableAccountingPartialError(
      'compensate_transaction_categorization',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.originalJournalEntryId,
        reversal_journal_entry_id: null,
        publication_ids: [],
      },
      lastError.message,
    )
  }

  const row = durableRpcRow(data)
  if (row?.status === 'conflict') {
    throw new DurableAccountingConflictError(
      'compensate_transaction_categorization',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.originalJournalEntryId,
        reversal_journal_entry_id:
          typeof row.reversal_journal_entry_id === 'string'
            ? row.reversal_journal_entry_id
            : null,
        publication_ids: [],
      },
      typeof row.reason === 'string' ? row.reason : 'persisted state differs',
    )
  }

  const outcome = parseCategorizationCompensation(
    data,
    params.companyId,
    params.transactionId,
    params.originalJournalEntryId,
  )
  if (!outcome) {
    const publications = Array.isArray(row?.publications)
      ? row.publications.filter(isDurablePublicationIdentity)
      : []
    throw new DurableAccountingIdentityError(
      'compensate_transaction_categorization',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.originalJournalEntryId,
        reversal_journal_entry_id:
          typeof row?.reversal_journal_entry_id === 'string'
            ? row.reversal_journal_entry_id
            : null,
        publication_ids: publications.map(
          (publication) => publication.publication_id,
        ),
      },
      'M5 compensation RPC returned malformed or contradictory identities',
    )
  }

  const entries = await hydrateDurableReversal(supabase, outcome)
  await emitDurableReversalEvents(outcome, entries, params.userId)
  return {
    outcome,
    originalEntry: entries.original,
    reversalEntry: entries.reversal,
  }
}

/**
 * Create a reversal entry for an existing journal entry
 * Sets reversed_by_id/reverses_id links for compliance tracking
 */
export async function reverseEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryId: string,
  reversalDate?: string,
  options?: {
    /**
     * Bypass the correction-chain depth guard for ordinary entries. Supplier
     * reversal depth and lineage are always enforced by M2/M3.
     */
    allowDeepChain?: boolean
    /** Verified API-key/MCP actor metadata for service-role calls. */
    actor?: AccountingActor
  }
): Promise<JournalEntry> {

  // Fetch original entry with lines
  const { data: original, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()

  if (error || !original) {
    throw new JournalEntryNotFoundError()
  }

  const lineage = await resolveSupplierPaymentLineage(supabase, companyId, entryId)
  if (lineage.is_supplier_payment) {
    const outcome = await applySupplierPaymentReversal(supabase, {
      companyId,
      requestedJournalEntryId: entryId,
      reversalDate: reversalDate ?? original.entry_date,
      actor: accountingActor(userId, options?.actor),
      lineage,
    })
    const entries = await hydrateDurableReversal(supabase, outcome)
    await emitDurableReversalEvents(outcome, entries, userId)
    return entries.reversal
  }
  if (
    !lineage.is_supplier_payment &&
    original.source_type.startsWith('supplier_invoice') &&
    isPaymentSourceType(original.source_type)
  ) {
    throw new DurableAccountingIdentityError(
      'resolve_supplier_payment_lineage',
      {
        company_id: companyId,
        original_journal_entry_id: entryId,
        reversal_journal_entry_id: original.reversed_by_id ?? null,
        publication_ids: [],
      },
      'typed supplier payment was not bound to an M2 supplier lineage',
    )
  }

  if (original.status !== 'posted') {
    throw new CannotReverseNonPostedError(original.status)
  }

  // A storno entry must never itself be reversed: a storno-of-a-storno makes
  // the original verifikat's cancellation chain ambiguous (BFL 5 kap 5§). A
  // correction entry, by contrast, is a regular live verifikation and must
  // stay reversible: it can be a duplicate (the affärshändelse already booked
  // by another verifikat) or plain wrong, and blocking it left users with no
  // sanctioned way out (support case 2026-07-26). Its correction_of_id link
  // keeps the chain traceable either way; the original it corrected stays
  // 'reversed'. The UI hides "Återför" for stornos; this is the server-side
  // backstop against a direct API call.
  if (original.source_type === 'storno') {
    throw new CannotReverseStornoError(original.source_type)
  }

  // Chain-depth guard: a storno on an entry already deep in a rättelse chain
  // is almost always an agent reflexively cancelling its own correction
  // (Christoffer case 2026-08-11). Same guard and bypass as correctEntry.
  if (!options?.allowDeepChain) {
    const chain = await correctionChainDepth(supabase, companyId, original)
    if (chain.depth >= CORRECTION_CHAIN_GUARD_DEPTH) {
      throw new CorrectionChainTooDeepError(chain.depth, chain.rootVoucher)
    }
  }

  const lines = (original.lines as JournalEntryLine[]) || []

  // Create reversed lines (swap debit and credit, preserve dimensions)
  const reversedLines: CreateJournalEntryLineInput[] = lines.map((line) => ({
    account_number: line.account_number,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: `Reversal: ${line.line_description || ''}`,
    currency: line.currency,
    amount_in_currency: line.amount_in_currency
      ? -line.amount_in_currency
      : undefined,
    exchange_rate: line.exchange_rate || undefined,
    tax_code: line.tax_code || undefined,
    dimensions: line.dimensions || undefined,
    cost_center: line.cost_center || undefined,
    project: line.project || undefined,
  }))

  const entryDate = reversalDate ?? original.entry_date

  // Get voucher number for the reversal
  const voucherNumber = await getNextVoucherNumber(
    supabase,
    companyId,
    original.fiscal_period_id,
    original.voucher_series || 'A'
  )

  // Resolve account IDs: include inactive rows. The accounts on the
  // original committed entry were active at commit time; if the user has
  // since toggled one off, the storno must still be allowed to go through
  // (BFL 5 kap 5§). Only a truly missing chart row (rare: would require
  // the row to have been deleted) still throws AccountsNotInChartError.
  const accountIdMap = await resolveAccountIds(supabase, companyId, reversedLines, { includeInactive: true })

  const reversalAccountNumbers = [...new Set(reversedLines.map(l => l.account_number))]
  const missingReversalAccounts = reversalAccountNumbers.filter(num => !accountIdMap.has(num))
  if (missingReversalAccounts.length > 0) {
    throw new AccountsNotInChartError(missingReversalAccounts)
  }

  // Create reversal entry with reverses_id link
  const { data: reversalEntry, error: reversalError } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: original.fiscal_period_id,
      voucher_number: voucherNumber,
      voucher_series: original.voucher_series || 'A',
      entry_date: entryDate,
      description: `Makulering: ${original.description}`,
      source_type: 'storno',
      source_id: original.source_id || null,
      reverses_id: entryId,
      status: 'draft',
    })
    .select()
    .single()

  if (reversalError || !reversalEntry) {
    throw new BookkeepingDatabaseError('create_reversal_entry', reversalError?.message)
  }

  // Insert reversal lines with dimensions
  const lineInserts = buildLineInserts(reversalEntry.id, reversedLines, accountIdMap)

  const { error: linesError } = await supabase
    .from('journal_entry_lines')
    .insert(lineInserts)

  if (linesError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new BookkeepingDatabaseError('create_reversal_lines', linesError.message)
  }

  // Post the reversal entry
  const { error: postError } = await supabase
    .from('journal_entries')
    .update({ status: 'posted' })
    .eq('id', reversalEntry.id)

  if (postError) {
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new BookkeepingDatabaseError('post_reversal_entry', postError.message)
  }

  // Mark original as reversed with reversed_by_id link (CAS guard: only if still 'posted')
  const { data: updatedOriginal, error: casError } = await supabase
    .from('journal_entries')
    .update({
      status: 'reversed',
      reversed_by_id: reversalEntry.id,
    })
    .eq('id', entryId)
    .eq('status', 'posted')
    .select('id')

  if (casError || !updatedOriginal || updatedOriginal.length === 0) {
    // Another concurrent reversal already changed the status: mark the orphaned
    // reversal as cancelled so it's excluded from reports but remains traceable.
    await supabase.from('journal_entries').update({ status: 'cancelled' }).eq('id', reversalEntry.id)
    await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', reversalEntry.id)
    throw new EntryAlreadyReversedError()
  }

  // Unlink any bank transactions booked by the reversed entry so they return
  // to "Att bokföra" and can be booked again from the transactions view.
  // Without this the row keeps pointing at a status='reversed' entry, reads
  // as bokförd forever, and has no re-booking affordance: the agent paths
  // (lib/pending-operations/commit.ts) already did this manually after every
  // reverseEntry call; the dashboard reverse route did not.
  const { error: unlinkError } = await supabase
    .from('transactions')
    .update({ journal_entry_id: null })
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
  if (unlinkError) {
    log.error('failed to unlink transactions from reversed entry', unlinkError, { entryId })
  }

  // Same hazard one table over: a period whose opening_balance_entry_id still
  // points at the entry we just reversed. getOpeningBalances() reads the linked
  // entry's lines directly with no status filter, so the Balansrapport would go
  // on showing a cancelled IB, and year-end refuses to run while the link is
  // non-null ("Next fiscal period already has opening balance entry posted;
  // reverse it before re-running year-end"): advice the storno itself could
  // never satisfy, leaving no in-app way out. Clearing the link falls
  // getOpeningBalances through to the duplicate-safe
  // compute_prior_opening_balances RPC, and lets year-end re-book the IB.
  //
  // Two statements, not one: enforce_opening_balance_immutability rejects any
  // UPDATE that changes opening_balance_entry_id while OLD.opening_balances_set
  // is still true, so the flag must fall first (same order, and same reason, as
  // the replace_period_opening_balance_link RPC). Both are scoped to this
  // entryId, so a period already pointing elsewhere is untouched and callers
  // that storno an old IB then relink a fresh one (opening-balance/correct)
  // still win: they relink after this returns.
  if (original.source_type === 'opening_balance') {
    const { error: obFlagError } = await supabase
      .from('fiscal_periods')
      .update({ opening_balances_set: false })
      .eq('company_id', companyId)
      .eq('opening_balance_entry_id', entryId)

    if (obFlagError) {
      log.error('failed to clear opening_balances_set on reversed IB period', obFlagError, {
        entryId,
      })
    } else {
      const { error: obUnlinkError } = await supabase
        .from('fiscal_periods')
        .update({ opening_balance_entry_id: null })
        .eq('company_id', companyId)
        .eq('opening_balance_entry_id', entryId)
      if (obUnlinkError) {
        log.error('failed to unlink reversed opening balance entry from period', obUnlinkError, {
          entryId,
        })
      }
    }
  }

  // If this was a payment entry, sync the linked invoice/supplier-invoice status.
  // Helper is shared with the DELETE journal entry route so both code paths leave
  // the invoice in a consistent state (BFL 5 kap 5§ requires GL reversal; this
  // covers the business-level state that lives outside the GL).
  if (isPaymentSourceType(original.source_type)) {
    await syncInvoiceStatusFromPaymentEntry(supabase, companyId, original as JournalEntry)
  }

  // Fetch complete reversal entry with lines
  const { data: completeEntry } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', reversalEntry.id)
    .single()

  const result = completeEntry as JournalEntry

  await eventBus.emit({
    type: 'journal_entry.committed',
    payload: { entry: result, userId, companyId },
  })

  await eventBus.emit({
    type: 'journal_entry.reversed',
    payload: { originalEntry: original as JournalEntry, reversalEntry: result, userId, companyId },
  })

  return result
}
