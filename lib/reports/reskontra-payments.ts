import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'

const SUPPLIER_PAYMENT_HISTORY_TABLE = 'supplier_invoice_payment_history'
const JOURNAL_LINEAGE_RPC = 'get_journal_lineage'
const MAX_CORRECTION_DEPTH = 32
const MAX_TERMINAL_STORNO_DEPTH = 33

type JournalLineageEdgeKind = 'root' | 'correction' | 'storno'

/**
 * Exact row contract returned inside the shared M2 lineage envelope.
 * Reports consume this graph directly and never reconstruct descendants from
 * journal tables.
 */
export interface JournalLineageNode {
  root_id: string
  parent_id: string | null
  edge_kind: JournalLineageEdgeKind
  id: string
  company_id: string
  entry_date: string
  status: 'posted' | 'reversed'
  source_type: string
  correction_of_id: string | null
  reverses_id: string | null
  reversed_by_id: string | null
  committed_at: string
  depth: number
  path: string[]
  cycle: false
}

export interface JournalLineageEnvelope {
  valid: true
  company_id: string
  requested_root_count: number
  row_count: number
  max_depth: number
  max_correction_depth: number
  terminal_storno_depth: number | null
  rows: JournalLineageNode[]
}

interface ParsedJournalLineage {
  rootId: string
  rows: JournalLineageNode[]
  byId: Map<string, JournalLineageNode>
  correctionChildren: Map<string, JournalLineageNode>
  stornoChildren: Map<string, JournalLineageNode>
  liveNodeId: string
}

const JournalLineageNodeSchema = z.object({
  root_id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
  edge_kind: z.enum(['root', 'correction', 'storno']),
  id: z.string().min(1),
  company_id: z.string().min(1),
  entry_date: z.string().min(1),
  status: z.enum(['posted', 'reversed']),
  source_type: z.string().min(1),
  correction_of_id: z.string().min(1).nullable(),
  reverses_id: z.string().min(1).nullable(),
  reversed_by_id: z.string().min(1).nullable(),
  committed_at: z.string().min(1),
  depth: z.number().int().min(0).max(MAX_TERMINAL_STORNO_DEPTH),
  path: z.array(z.string().min(1)).min(1),
  cycle: z.literal(false),
}).strict()

const JournalLineageEnvelopeSchema = z.object({
  valid: z.literal(true),
  company_id: z.string().min(1),
  requested_root_count: z.number().int().positive(),
  row_count: z.number().int().positive(),
  max_depth: z.number().int().min(0).max(MAX_TERMINAL_STORNO_DEPTH),
  max_correction_depth: z.number().int().min(0).max(MAX_CORRECTION_DEPTH),
  terminal_storno_depth: z.number().int().min(1)
    .max(MAX_TERMINAL_STORNO_DEPTH).nullable(),
  rows: z.array(JournalLineageNodeSchema).min(1),
}).strict()

export interface EffectiveJournalEntry {
  effective: boolean
  rootId: string
  entryId: string | null
  entryDate: string | null
  terminalStornoId: string | null
}

/**
 * Payment history for reconstructing a reskontra as of an arbitrary date.
 *
 * `paidThrough` sums economically effective payment roots dated on or before
 * the cutoff. `hasRows` includes active and retained-history allocations at
 * every date so a later reversal never makes callers fall back to mutable
 * invoice totals.
 */
export interface PaymentsAsOf {
  paidThrough: Map<string, number>
  hasRows: Set<string>
}

interface PaymentRow {
  id: string
  invoiceId: string
  amount: number
  paymentDate: string
  journalEntryId: string | null
  retained: boolean
  lineageRootJournalEntryId: string | null
  reversedLiveJournalEntryId: string | null
  reversedByJournalEntryId: string | null
}

export interface ReskontraInvoiceAsOf {
  id: string
  /** Positive stored magnitude. Use `sign: -1` for supplier credit notes. */
  total: number
  /** Positive stored magnitude from the current row. */
  liveOutstanding: number
  paidAt?: string | null
  sign?: 1 | -1
  /**
   * `required` excludes an invoice until its registration lineage was
   * economically effective. `optional` is for kontantmetoden documents, where
   * a null source is precisely the unbooked population being collected.
   */
  registrationEvidence?: 'required' | 'optional'
  registrationJournalEntryId?: string | null
  /**
   * For kontantmetoden credit documents: an effective source means the credit
   * is already represented in the immutable journal and must not be collected
   * a second time.
   */
  sourceJournalEntryId?: string | null
  excludeWhenSourceEffective?: boolean
}

export interface ReskontraAsOf {
  outstandingByInvoice: Map<string, number>
  payments: PaymentsAsOf
}

const cutoffIncludes = (
  row: Pick<JournalLineageNode, 'entry_date' | 'committed_at'>,
  asOfDate: string,
): boolean =>
  row.entry_date <= asOfDate &&
  row.committed_at.slice(0, 10) <= asOfDate

function invalidLineage(detail: string): never {
  throw new Error(`Journal lineage returned an invalid envelope: ${detail}`)
}

function parseJournalLineageEnvelope(
  value: unknown,
  companyId: string,
  requestedRootIds: string[],
): Map<string, ParsedJournalLineage> {
  const parsed = JournalLineageEnvelopeSchema.safeParse(value)
  if (!parsed.success) invalidLineage('schema mismatch')
  const envelope = parsed.data
  const expectedRoots = [...new Set(requestedRootIds)].sort()
  if (
    envelope.company_id !== companyId ||
    envelope.requested_root_count !== expectedRoots.length ||
    envelope.row_count !== envelope.rows.length
  ) {
    invalidLineage('company, root, or row count mismatch')
  }

  const rootIds = [...new Set(envelope.rows.map((row) => row.root_id))].sort()
  if (
    rootIds.length !== expectedRoots.length ||
    rootIds.some((rootId, index) => rootId !== expectedRoots[index])
  ) {
    invalidLineage('requested roots do not match emitted roots')
  }

  const maxDepth = Math.max(...envelope.rows.map((row) => row.depth))
  const maxCorrectionDepth = Math.max(
    ...envelope.rows
      .filter((row) => row.edge_kind !== 'storno')
      .map((row) => row.depth),
  )
  const stornoDepths = envelope.rows
    .filter((row) => row.edge_kind === 'storno')
    .map((row) => row.depth)
  const terminalStornoDepth = stornoDepths.length > 0
    ? Math.max(...stornoDepths)
    : null
  if (
    envelope.max_depth !== maxDepth ||
    envelope.max_correction_depth !== maxCorrectionDepth ||
    envelope.terminal_storno_depth !== terminalStornoDepth
  ) {
    invalidLineage('depth summary mismatch')
  }

  const globallySeenIds = new Set<string>()
  const graphs = new Map<string, ParsedJournalLineage>()
  for (const rootId of rootIds) {
    const rows = envelope.rows.filter((row) => row.root_id === rootId)
    const byId = new Map<string, JournalLineageNode>()
    for (const row of rows) {
      if (
        globallySeenIds.has(row.id) ||
        byId.has(row.id) ||
        row.company_id !== companyId ||
        row.path.length !== row.depth + 1 ||
        row.path[0] !== rootId ||
        row.path[row.path.length - 1] !== row.id ||
        new Set(row.path).size !== row.path.length
      ) {
        invalidLineage(`contradictory identity or path at ${row.id}`)
      }
      globallySeenIds.add(row.id)
      byId.set(row.id, row)
    }

    const rootRows = rows.filter((row) => row.edge_kind === 'root')
    if (rootRows.length !== 1) invalidLineage(`root count mismatch for ${rootId}`)
    const root = rootRows[0]!
    if (
      root.id !== rootId ||
      root.parent_id !== null ||
      root.depth !== 0 ||
      root.path.length !== 1 ||
      root.source_type === 'correction' ||
      root.source_type === 'storno' ||
      root.correction_of_id !== null ||
      root.reverses_id !== null
    ) {
      invalidLineage(`invalid root ${rootId}`)
    }

    const correctionChildren = new Map<string, JournalLineageNode>()
    const stornoChildren = new Map<string, JournalLineageNode>()
    for (const row of rows) {
      if (row.edge_kind === 'root') continue
      const parent = row.parent_id ? byId.get(row.parent_id) : null
      if (
        !parent ||
        parent.edge_kind === 'storno' ||
        row.depth !== parent.depth + 1 ||
        row.path.length !== parent.path.length + 1 ||
        !parent.path.every((id, index) => row.path[index] === id)
      ) {
        invalidLineage(`invalid parent path at ${row.id}`)
      }

      const children = row.edge_kind === 'correction'
        ? correctionChildren
        : stornoChildren
      if (children.has(parent.id)) invalidLineage(`ambiguous branch at ${parent.id}`)
      children.set(parent.id, row)

      if (
        (
          row.edge_kind === 'correction' &&
          (
            row.source_type !== 'correction' ||
            row.correction_of_id !== parent.id ||
            row.reverses_id !== null ||
            row.depth > MAX_CORRECTION_DEPTH
          )
        ) ||
        (
          row.edge_kind === 'storno' &&
          (
            row.source_type !== 'storno' ||
            row.reverses_id !== parent.id ||
            row.correction_of_id !== null ||
            row.reversed_by_id !== null ||
            row.status !== 'posted'
          )
        )
      ) {
        invalidLineage(`invalid ${row.edge_kind} edge at ${row.id}`)
      }
    }

    for (const row of rows) {
      const correction = correctionChildren.get(row.id)
      const storno = stornoChildren.get(row.id)
      if (row.edge_kind === 'storno' && (correction || storno)) {
        invalidLineage(`storno ${row.id} has descendants`)
      }
      if (row.edge_kind !== 'storno') {
        if (
          (
            row.status === 'posted' &&
            (row.reversed_by_id !== null || storno != null)
          ) ||
          (
            row.status === 'reversed' &&
            (!storno || row.reversed_by_id !== storno.id)
          ) ||
          (correction != null && row.status !== 'reversed')
        ) {
          invalidLineage(`status and reverse pointer mismatch at ${row.id}`)
        }
      }
    }

    let live = root
    while (correctionChildren.has(live.id)) {
      live = correctionChildren.get(live.id)!
    }
    graphs.set(rootId, {
      rootId,
      rows,
      byId,
      correctionChildren,
      stornoChildren,
      liveNodeId: live.id,
    })
  }
  return graphs
}

async function fetchJournalLineages(
  supabase: SupabaseClient,
  companyId: string,
  rootIds: string[],
): Promise<Map<string, ParsedJournalLineage>> {
  const uniqueRootIds = [...new Set(rootIds.filter(Boolean))].sort()
  if (uniqueRootIds.length === 0) return new Map()
  const { data, error } = await supabase.rpc(JOURNAL_LINEAGE_RPC, {
    p_company_id: companyId,
    p_root_ids: uniqueRootIds,
  })
  if (error) {
    throw new Error(`Journal lineage could not be reconstructed: ${error.message}`)
  }
  return parseJournalLineageEnvelope(data, companyId, uniqueRootIds)
}

function resolveLineageAsOf(
  lineage: ParsedJournalLineage,
  asOfDate: string,
): EffectiveJournalEntry {
  let current = lineage.byId.get(lineage.rootId)!
  while (true) {
    if (!cutoffIncludes(current, asOfDate)) {
      return {
        effective: false,
        rootId: lineage.rootId,
        entryId: null,
        entryDate: null,
        terminalStornoId: null,
      }
    }

    const correction = lineage.correctionChildren.get(current.id)
    const storno = lineage.stornoChildren.get(current.id)
    const correctionAtCutoff = correction
      ? cutoffIncludes(correction, asOfDate)
      : false
    const stornoAtCutoff = storno ? cutoffIncludes(storno, asOfDate) : false

    if (correctionAtCutoff && !stornoAtCutoff) {
      throw new Error(`Journal correction ${correction!.id} lacks its effective storno`)
    }
    if (correctionAtCutoff && stornoAtCutoff) {
      if (correction!.entry_date !== storno!.entry_date) {
        throw new Error(`Journal correction pair has mismatched accounting dates at ${current.id}`)
      }
      current = correction!
      continue
    }
    if (stornoAtCutoff) {
      return {
        effective: false,
        rootId: lineage.rootId,
        entryId: null,
        entryDate: null,
        terminalStornoId: storno!.id,
      }
    }
    return {
      effective: true,
      rootId: lineage.rootId,
      entryId: current.id,
      entryDate: current.entry_date,
      terminalStornoId: null,
    }
  }
}

/**
 * Resolve terminal economic state for true M2 lineage roots at a cutoff.
 */
export async function fetchEffectiveJournalEntriesAsOf(
  supabase: SupabaseClient,
  companyId: string,
  rootIds: string[],
  asOfDate: string,
): Promise<Map<string, EffectiveJournalEntry>> {
  const lineages = await fetchJournalLineages(supabase, companyId, rootIds)
  return new Map(
    [...lineages.entries()].map(([rootId, lineage]) => [
      rootId,
      resolveLineageAsOf(lineage, asOfDate),
    ]),
  )
}

function parseActivePaymentRows(
  rows: Array<Record<string, unknown>>,
  invoiceIdColumn: string,
): PaymentRow[] {
  return rows.map((row) => {
    const amount = Number(row.amount)
    if (
      typeof row.id !== 'string' ||
      typeof row[invoiceIdColumn] !== 'string' ||
      !Number.isFinite(amount) ||
      typeof row.payment_date !== 'string' ||
      (row.journal_entry_id !== null && typeof row.journal_entry_id !== 'string')
    ) {
      throw new Error('Active payment allocation is malformed')
    }
    return {
      id: row.id,
      invoiceId: row[invoiceIdColumn],
      amount,
      paymentDate: row.payment_date,
      journalEntryId: row.journal_entry_id,
      retained: false,
      lineageRootJournalEntryId: null,
      reversedLiveJournalEntryId: null,
      reversedByJournalEntryId: null,
    }
  })
}

function parseHistoricalPaymentRows(
  rows: Array<Record<string, unknown>>,
  invoiceIdColumn: string,
): PaymentRow[] {
  return rows.map((row) => {
    const amount = Number(row.amount)
    if (
      typeof row.original_payment_id !== 'string' ||
      typeof row[invoiceIdColumn] !== 'string' ||
      !Number.isFinite(amount) ||
      typeof row.payment_date !== 'string' ||
      typeof row.journal_entry_id !== 'string' ||
      typeof row.lineage_root_journal_entry_id !== 'string' ||
      typeof row.reversed_live_journal_entry_id !== 'string' ||
      typeof row.reversed_by_journal_entry_id !== 'string'
    ) {
      throw new Error('Historical supplier payment allocation is malformed')
    }
    return {
      id: row.original_payment_id,
      invoiceId: row[invoiceIdColumn],
      amount,
      paymentDate: row.payment_date,
      journalEntryId: row.journal_entry_id,
      retained: true,
      lineageRootJournalEntryId: row.lineage_root_journal_entry_id,
      reversedLiveJournalEntryId: row.reversed_live_journal_entry_id,
      reversedByJournalEntryId: row.reversed_by_journal_entry_id,
    }
  })
}

async function fetchPaymentLineages(
  supabase: SupabaseClient,
  companyId: string,
  rows: PaymentRow[],
): Promise<Map<string, ParsedJournalLineage>> {
  const historyRoots = rows.flatMap((row) =>
    row.lineageRootJournalEntryId ? [row.lineageRootJournalEntryId] : [],
  )
  const lineages = await fetchJournalLineages(supabase, companyId, historyRoots)
  const coveredNodeIds = new Set(
    [...lineages.values()].flatMap((lineage) => lineage.rows.map((row) => row.id)),
  )
  const uncoveredActiveOwners = rows.flatMap((row) =>
    !row.retained &&
    row.journalEntryId &&
    !coveredNodeIds.has(row.journalEntryId)
      ? [row.journalEntryId]
      : [],
  )
  const activeLineages = await fetchJournalLineages(
    supabase,
    companyId,
    uncoveredActiveOwners,
  )
  for (const [rootId, lineage] of activeLineages) {
    if (lineages.has(rootId)) invalidLineage(`duplicate payment root ${rootId}`)
    lineages.set(rootId, lineage)
  }
  return lineages
}

function validatePaymentOwnership(
  rows: PaymentRow[],
  lineages: Map<string, ParsedJournalLineage>,
): Map<string, ParsedJournalLineage> {
  const lineageByNode = new Map<string, ParsedJournalLineage>()
  for (const lineage of lineages.values()) {
    for (const node of lineage.rows) {
      if (lineageByNode.has(node.id)) invalidLineage(`node ${node.id} has multiple roots`)
      lineageByNode.set(node.id, lineage)
    }
  }

  const lineageByAllocation = new Map<string, ParsedJournalLineage>()
  const ownersByRoot = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.journalEntryId) continue
    const lineage = row.retained
      ? lineages.get(row.lineageRootJournalEntryId!)
      : lineageByNode.get(row.journalEntryId)
    const owner = lineage?.byId.get(row.journalEntryId)
    if (!lineage || !owner || owner.edge_kind === 'storno') {
      throw new Error(`Payment allocation ${row.id} has no valid lineage owner`)
    }

    const ownerIsRoot = row.journalEntryId === lineage.rootId
    const ownerIsExactCorrection = owner.edge_kind === 'correction' && (
      row.retained
        ? row.journalEntryId === row.reversedLiveJournalEntryId
        : row.journalEntryId === lineage.liveNodeId
    )
    if (!ownerIsRoot && !ownerIsExactCorrection) {
      throw new Error(`Payment allocation ${row.id} has an invalid lineage owner`)
    }

    const owners = ownersByRoot.get(lineage.rootId) ?? new Set<string>()
    owners.add(row.journalEntryId)
    ownersByRoot.set(lineage.rootId, owners)
    if (owners.size > 1) {
      throw new Error(`Payment lineage ${lineage.rootId} has multiple allocation owners`)
    }

    if (row.retained) {
      const reversedLive = lineage.byId.get(row.reversedLiveJournalEntryId!)
      const terminalStorno = lineage.stornoChildren.get(row.reversedLiveJournalEntryId!)
      if (
        !reversedLive ||
        reversedLive.edge_kind === 'storno' ||
        lineage.liveNodeId !== reversedLive.id ||
        terminalStorno?.id !== row.reversedByJournalEntryId
      ) {
        throw new Error(`Historical payment allocation ${row.id} has invalid reversal identity`)
      }
    } else if (lineage.stornoChildren.has(lineage.liveNodeId)) {
      throw new Error(`Active payment allocation ${row.id} belongs to a reversed lineage`)
    }
    lineageByAllocation.set(row.id, lineage)
  }
  return lineageByAllocation
}

/**
 * Fetch active payment rows plus immutable retained supplier-payment history
 * and aggregate only roots whose terminal lineage is effective at `asOfDate`.
 */
export async function fetchPaymentsAsOf(
  supabase: SupabaseClient,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  invoiceIdColumn: 'invoice_id' | 'supplier_invoice_id',
  companyId: string,
  asOfDate: string,
): Promise<PaymentsAsOf> {
  const activeData = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
    supabase
      .from(table)
      .select(`id, ${invoiceIdColumn}, amount, payment_date, journal_entry_id`)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const activeRows = parseActivePaymentRows(activeData, invoiceIdColumn)

  const historicalData = table === 'supplier_invoice_payments'
    ? await fetchAllRows<Record<string, unknown>>(({ from, to }) => {
        const query = supabase
          .from(SUPPLIER_PAYMENT_HISTORY_TABLE)
          .select(
            `original_payment_id, ${invoiceIdColumn}, amount, payment_date, ` +
            'journal_entry_id, lineage_root_journal_entry_id, ' +
            'reversed_live_journal_entry_id, reversed_by_journal_entry_id',
          )
          .eq('company_id', companyId)
          .order('original_payment_id', { ascending: true })
          .range(from, to)
        // M3 owns this pending table contract; generated database types lag it.
        return query as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null
          error: { message: string } | null
        }>
      })
    : []
  const historicalRows = parseHistoricalPaymentRows(historicalData, invoiceIdColumn)

  const rowsById = new Map<string, PaymentRow>()
  for (const row of [...activeRows, ...historicalRows]) {
    if (rowsById.has(row.id)) {
      throw new Error(`Payment allocation ${row.id} appears more than once`)
    }
    rowsById.set(row.id, row)
  }
  const rows = [...rowsById.values()]
  const lineages = await fetchPaymentLineages(supabase, companyId, rows)
  const lineageByAllocation = validatePaymentOwnership(rows, lineages)
  const effectiveByRoot = new Map(
    [...lineages.entries()].map(([rootId, lineage]) => [
      rootId,
      resolveLineageAsOf(lineage, asOfDate),
    ]),
  )

  const paidThrough = new Map<string, number>()
  const hasRows = new Set<string>()
  for (const row of rows) {
    hasRows.add(row.invoiceId)
    if (!row.paymentDate || row.paymentDate > asOfDate) continue
    if (row.journalEntryId) {
      const lineage = lineageByAllocation.get(row.id)
      const terminal = lineage
        ? effectiveByRoot.get(lineage.rootId)
        : undefined
      if (!terminal?.effective) continue
    }
    const previous = paidThrough.get(row.invoiceId) ?? 0
    paidThrough.set(row.invoiceId, roundOre(previous + row.amount))
  }

  return { paidThrough, hasRows }
}

/**
 * Reconstruct signed outstanding amounts from the same payment, registration,
 * and source lineage for supplier ledger, reconciliation, readiness, and
 * kontantmetoden cutoff.
 */
export async function reconstructReskontraAsOf(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  invoiceIdColumn: 'invoice_id' | 'supplier_invoice_id',
  invoices: ReskontraInvoiceAsOf[],
): Promise<ReskontraAsOf> {
  const [payments, evidence] = await Promise.all([
    fetchPaymentsAsOf(supabase, table, invoiceIdColumn, companyId, asOfDate),
    fetchEffectiveJournalEntriesAsOf(
      supabase,
      companyId,
      invoices.flatMap((invoice) => [
        ...(invoice.registrationJournalEntryId ? [invoice.registrationJournalEntryId] : []),
        ...(invoice.sourceJournalEntryId ? [invoice.sourceJournalEntryId] : []),
      ]),
      asOfDate,
    ),
  ])

  const outstandingByInvoice = new Map<string, number>()
  for (const invoice of invoices) {
    if (invoice.registrationEvidence === 'required') {
      if (!invoice.registrationJournalEntryId) continue
      if (!evidence.get(invoice.registrationJournalEntryId)?.effective) continue
    }
    if (
      invoice.excludeWhenSourceEffective &&
      invoice.sourceJournalEntryId &&
      evidence.get(invoice.sourceJournalEntryId)?.effective
    ) {
      continue
    }

    const sign = invoice.sign ?? 1
    const magnitude = outstandingAsOf(
      { id: invoice.id, paid_at: invoice.paidAt },
      Math.abs(invoice.total),
      Math.abs(invoice.liveOutstanding),
      payments,
      asOfDate,
    )
    outstandingByInvoice.set(invoice.id, roundOre(magnitude * sign))
  }

  return { outstandingByInvoice, payments }
}

/**
 * An invoice's outstanding amount (in invoice currency) as of the
 * reconstruction date.
 */
export function outstandingAsOf(
  invoice: { id: string; paid_at?: string | null },
  total: number,
  liveOutstanding: number,
  payments: PaymentsAsOf,
  asOfDate: string,
): number {
  if (payments.hasRows.has(invoice.id)) {
    const paid = payments.paidThrough.get(invoice.id) ?? 0
    return roundOre(total - paid)
  }
  if (invoice.paid_at) {
    return String(invoice.paid_at).slice(0, 10) <= asOfDate ? liveOutstanding : total
  }
  return liveOutstanding
}

/** Local calendar date used only to retain the established live-report fast path. */
export function todayIsoDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
