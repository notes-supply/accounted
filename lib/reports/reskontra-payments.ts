import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'

/**
 * Payment history for reconstructing a reskontra as of an arbitrary date.
 *
 * `paidThrough` sums the payment rows dated on or before the as-of date, per
 * invoice. `hasRows` marks invoices that have ANY payment rows (any date):
 * callers need it to tell "paid, but after the as-of date" (reconstructable,
 * paid-through 0) apart from "no payment rows recorded at all" (legacy data,
 * fall back to the invoice's own paid_at / stored amounts).
 */
export interface PaymentsAsOf {
  paidThrough: Map<string, number>
  hasRows: Set<string>
}

interface PaymentRow {
  id: string
  amount: number | string | null
  payment_date: string
}

interface SupplierPaymentRow extends PaymentRow {
  journal_entry_id: string | null
  reversed_at: string | null
  reversed_by_journal_entry_id: string | null
  supplier_invoice_id: string
}

interface JournalLineageRow {
  id: string
  entry_date: string
  status: string
  source_type: string | null
  correction_of_id: string | null
  reverses_id: string | null
  committed_at: string | null
}

interface JournalLineageRpcRow extends JournalLineageRow {
  root_id: string
  parent_id: string | null
  edge_kind: 'root' | 'correction' | 'storno'
  depth: number
  path: string[]
  cycle: boolean
}

// A valid maximum-depth correction chain emits the root, up to 32
// corrections, and one exact storno for every reversed entry: at most 65
// rows per root. 300 roots therefore leave 500 rows of headroom below the
// RPC's 20,000-row cap.
const SUPPLIER_LINEAGE_ROOT_BATCH_SIZE = 300

interface JournalLineage {
  roots: Map<string, JournalLineageRow>
  correctionsByParent: Map<string, JournalLineageRow[]>
  reversalsByParent: Map<string, JournalLineageRow[]>
}

function assertCommittedLineageEntry(entry: JournalLineageRow): void {
  if (!entry.id || !entry.entry_date) {
    throw new Error(
      `Could not prove supplier payment journal lineage for entry ${entry.id || '<missing id>'}`,
    )
  }
  if (entry.status !== 'posted' && entry.status !== 'reversed') {
    throw new Error(
      `Unexpected supplier payment journal lineage status ${entry.status} for entry ${entry.id}`,
    )
  }
}

function parseLineageRow(value: unknown): JournalLineageRpcRow {
  if (!value || typeof value !== 'object') {
    throw new Error('Malformed supplier payment journal lineage response')
  }
  const row = value as Record<string, unknown>
  const edgeKind = row.edge_kind
  if (
    typeof row.root_id !== 'string'
    || typeof row.id !== 'string'
    || typeof row.entry_date !== 'string'
    || typeof row.status !== 'string'
    || (row.source_type !== null && typeof row.source_type !== 'string')
    || (row.correction_of_id !== null && typeof row.correction_of_id !== 'string')
    || (row.reverses_id !== null && typeof row.reverses_id !== 'string')
    || (row.parent_id !== null && typeof row.parent_id !== 'string')
    || (row.committed_at !== null && typeof row.committed_at !== 'string')
    || (edgeKind !== 'root' && edgeKind !== 'correction' && edgeKind !== 'storno')
    || !Number.isInteger(row.depth)
    || !Array.isArray(row.path)
    || !row.path.every((id) => typeof id === 'string')
    || typeof row.cycle !== 'boolean'
  ) {
    throw new Error('Malformed supplier payment journal lineage response')
  }
  return row as unknown as JournalLineageRpcRow
}

export async function fetchSupplierJournalLineage(
  supabase: SupabaseClient,
  companyId: string,
  rootIds: string[],
): Promise<JournalLineage> {
  const requestedRootIds = Array.from(new Set(rootIds)).sort()
  const empty = {
    roots: new Map<string, JournalLineageRow>(),
    correctionsByParent: new Map<string, JournalLineageRow[]>(),
    reversalsByParent: new Map<string, JournalLineageRow[]>(),
  }
  if (requestedRootIds.length === 0) return empty

  const rows: JournalLineageRpcRow[] = []
  for (
    let offset = 0;
    offset < requestedRootIds.length;
    offset += SUPPLIER_LINEAGE_ROOT_BATCH_SIZE
  ) {
    const batchRootIds = requestedRootIds.slice(
      offset,
      offset + SUPPLIER_LINEAGE_ROOT_BATCH_SIZE,
    )
    const { data, error } = await supabase.rpc('get_supplier_payment_lineage', {
      p_company_id: companyId,
      p_root_ids: batchRootIds,
    })
    if (error) {
      throw new Error(`Could not fetch supplier payment journal lineage: ${error.message}`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Malformed supplier payment journal lineage response')
    }

    const payload = data as Record<string, unknown>
    if (
      payload.requested_root_count !== batchRootIds.length
      || !Array.isArray(payload.rows)
    ) {
      throw new Error('Malformed supplier payment journal lineage response')
    }
    const batchRoots = new Set(batchRootIds)
    for (const value of payload.rows) {
      const row = parseLineageRow(value)
      if (!batchRoots.has(row.root_id)) {
        throw new Error(`Malformed supplier payment journal lineage for entry ${row.id}`)
      }
      rows.push(row)
    }
  }

  const requested = new Set(requestedRootIds)
  const roots = new Map<string, JournalLineageRow>()
  const entriesById = new Map<string, JournalLineageRow>()
  const corrections = new Map<string, Map<string, JournalLineageRow>>()
  const reversals = new Map<string, Map<string, JournalLineageRow>>()

  for (const row of rows) {
    assertCommittedLineageEntry(row)
    if (
      !requested.has(row.root_id)
      || row.path[0] !== row.root_id
      || row.path.at(-1) !== row.id
      || row.path.length !== row.depth + 1
    ) {
      throw new Error(`Malformed supplier payment journal lineage for entry ${row.id}`)
    }
    if (row.cycle) {
      throw new Error(`Cyclic supplier payment journal lineage at entry ${row.id}`)
    }

    const existing = entriesById.get(row.id)
    if (existing && (
      existing.entry_date !== row.entry_date
      || existing.status !== row.status
      || existing.source_type !== row.source_type
      || existing.correction_of_id !== row.correction_of_id
      || existing.committed_at !== row.committed_at
      || existing.reverses_id !== row.reverses_id
    )) {
      throw new Error(`Conflicting supplier payment journal lineage for entry ${row.id}`)
    }
    entriesById.set(row.id, row)

    if (row.edge_kind === 'root') {
      if (
        row.parent_id !== null
        || row.depth !== 0
        || row.id !== row.root_id
        || roots.has(row.root_id)
      ) {
        throw new Error(`Malformed supplier payment journal root ${row.root_id}`)
      }
      roots.set(row.root_id, row)
      continue
    }

    if (!row.parent_id || row.depth < 1) {
      throw new Error(`Malformed supplier payment journal lineage for entry ${row.id}`)
    }
    const target = row.edge_kind === 'correction' ? corrections : reversals
    const siblings = target.get(row.parent_id) ?? new Map<string, JournalLineageRow>()
    siblings.set(row.id, row)
    target.set(row.parent_id, siblings)
  }

  for (const row of rows) {
    if (row.edge_kind === 'root') continue
    if (!row.parent_id || !entriesById.has(row.parent_id)) {
      throw new Error(`Orphaned supplier payment journal lineage at entry ${row.id}`)
    }
    if (
      row.edge_kind === 'correction'
      && (
        row.source_type !== 'correction'
        || row.correction_of_id !== row.parent_id
        || row.reverses_id !== null
      )
    ) {
      throw new Error(`Malformed correction lineage for supplier payment entry ${row.parent_id}`)
    }
    if (
      row.edge_kind === 'storno'
      && (
        row.source_type !== 'storno'
        || row.status !== 'posted'
        || row.reverses_id !== row.parent_id
        || row.correction_of_id !== null
      )
    ) {
      throw new Error(`Malformed storno lineage for supplier payment entry ${row.parent_id}`)
    }
  }

  for (const [parentId, children] of corrections) {
    if (children.size > 1) {
      throw new Error(`Ambiguous supplier payment correction lineage for entry ${parentId}`)
    }
  }
  for (const [parentId, children] of reversals) {
    if (children.size > 1) {
      throw new Error(`Ambiguous supplier payment storno lineage for entry ${parentId}`)
    }
  }

  const unresolved = requestedRootIds.filter((id) => !roots.has(id))
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve ${unresolved.length} supplier payment journal entries`,
    )
  }

  return {
    roots,
    correctionsByParent: new Map(
      Array.from(corrections, ([parentId, children]) => [parentId, Array.from(children.values())]),
    ),
    reversalsByParent: new Map(
      Array.from(reversals, ([parentId, children]) => [parentId, Array.from(children.values())]),
    ),
  }
}

export function effectiveAccountingDateAtCutoff(
  entry: JournalLineageRow,
  lineage: JournalLineage,
  asOfDate: string,
  visiting: Set<string> = new Set(),
): string | null {
  assertCommittedLineageEntry(entry)
  const corrections = lineage.correctionsByParent.get(entry.id) ?? []
  const reversals = lineage.reversalsByParent.get(entry.id) ?? []
  if (entry.status === 'posted') {
    if (corrections.length > 0 || reversals.length > 0) {
      throw new Error(
        `Contradictory partial supplier payment journal lineage for posted entry ${entry.id}`,
      )
    }
    return entry.entry_date <= asOfDate ? entry.entry_date : null
  }
  if (visiting.has(entry.id)) {
    throw new Error(`Cyclic supplier payment journal lineage at entry ${entry.id}`)
  }

  const nextVisiting = new Set(visiting)
  nextVisiting.add(entry.id)
  if (corrections.length > 1) {
    throw new Error(`Ambiguous supplier payment correction lineage for entry ${entry.id}`)
  }
  if (reversals.length !== 1) {
    throw new Error(`Could not resolve storno lineage for supplier payment entry ${entry.id}`)
  }

  const reversal = reversals[0]
  assertCommittedLineageEntry(reversal)
  if (
    reversal.source_type !== 'storno'
    || reversal.reverses_id !== entry.id
    || reversal.status !== 'posted'
  ) {
    throw new Error(`Malformed storno lineage for supplier payment entry ${entry.id}`)
  }

  const correction = corrections[0]
  if (!correction) {
    return entry.entry_date <= asOfDate && reversal.entry_date > asOfDate
      ? entry.entry_date
      : null
  }

  assertCommittedLineageEntry(correction)
  if (
    correction.source_type !== 'correction'
    || correction.correction_of_id !== entry.id
    || reversal.entry_date !== entry.entry_date
  ) {
    throw new Error(`Malformed correction lineage for supplier payment entry ${entry.id}`)
  }

  // The original and same-date storno net to zero immediately. Only the live
  // correction branch represents the payment, even when its first child is
  // future-dated and a later correction moves the effect back before cutoff.
  return effectiveAccountingDateAtCutoff(
    correction,
    lineage,
    asOfDate,
    nextVisiting,
  )
}

function resolveRetainedReversal(
  root: JournalLineageRow,
  lineage: JournalLineage,
  reversalId: string,
): { target: JournalLineageRow; reversal: JournalLineageRow } | null {
  let current = root
  const visited = new Set<string>()
  while (!visited.has(current.id)) {
    visited.add(current.id)
    const corrections = lineage.correctionsByParent.get(current.id) ?? []
    const reversal = (lineage.reversalsByParent.get(current.id) ?? [])
      .find((entry) => entry.id === reversalId)
    if (reversal) {
      return corrections.length === 0 ? { target: current, reversal } : null
    }
    if (corrections.length !== 1) return null
    current = corrections[0]
  }
  return null
}

/**
 * Fetch the company's payment rows for one of the two invoice ledgers and
 * aggregate them per invoice as of `asOfDate` (inclusive). Amounts are in the
 * invoice's own currency, matching how the ledger generators convert to SEK
 * with the invoice-date exchange_rate.
 */
export async function fetchPaymentsAsOf(
  supabase: SupabaseClient,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  invoiceIdColumn: 'invoice_id' | 'supplier_invoice_id',
  companyId: string,
  asOfDate: string
): Promise<PaymentsAsOf> {
  const isSupplierLedger = table === 'supplier_invoice_payments'
  let rows: Array<PaymentRow & Record<string, unknown>>
  if (isSupplierLedger) {
    rows = await fetchAllRows<SupplierPaymentRow & Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('supplier_invoice_payments')
        .select(
          'supplier_invoice_id, id, amount, payment_date, journal_entry_id, reversed_at, reversed_by_journal_entry_id',
        )
        .eq('company_id', companyId)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to),
    )
  } else {
    rows = await fetchAllRows<PaymentRow & Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('invoice_payments')
        .select('invoice_id, id, amount, payment_date')
        .eq('company_id', companyId)
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to),
    )
  }

  let supplierRoots = new Map<string, JournalLineageRow>()
  let supplierLineage: JournalLineage = {
    roots: supplierRoots,
    correctionsByParent: new Map(),
    reversalsByParent: new Map(),
  }
  const supplierAllocationsByRoot = new Map<string, Map<string, number>>()
  if (isSupplierLedger) {
    const rootIds = new Set<string>()
    for (const rawRow of rows) {
      const row = rawRow as SupplierPaymentRow & Record<string, unknown>
      const hasReversalTimestamp = row.reversed_at !== null
      const hasReversalLink = row.reversed_by_journal_entry_id !== null
      if (hasReversalTimestamp !== hasReversalLink) {
        throw new Error(`Malformed supplier payment reversal metadata for ${row.id}`)
      }
      if (
        row.reversed_at !== null
        && !Number.isFinite(Date.parse(row.reversed_at))
      ) {
        throw new Error(`Malformed supplier payment reversal timestamp for ${row.id}`)
      }
      if (hasReversalLink && !row.journal_entry_id) {
        throw new Error(`Missing original journal lineage for supplier payment ${row.id}`)
      }
      if (row.journal_entry_id) {
        const invoiceAmounts = supplierAllocationsByRoot.get(row.journal_entry_id)
          ?? new Map<string, number>()
        invoiceAmounts.set(
          row.supplier_invoice_id,
          roundOre(
            (invoiceAmounts.get(row.supplier_invoice_id) ?? 0)
            + (Number(row.amount) || 0),
          ),
        )
        supplierAllocationsByRoot.set(row.journal_entry_id, invoiceAmounts)
        rootIds.add(row.journal_entry_id)
      }
    }

    supplierLineage = await fetchSupplierJournalLineage(
      supabase,
      companyId,
      Array.from(rootIds),
    )
    supplierRoots = supplierLineage.roots

    for (const rawRow of rows) {
      const row = rawRow as SupplierPaymentRow & Record<string, unknown>
      if (!row.reversed_by_journal_entry_id || !row.journal_entry_id) continue
      const root = supplierRoots.get(row.journal_entry_id)
      const retainedReversal = root
        ? resolveRetainedReversal(root, supplierLineage, row.reversed_by_journal_entry_id)
        : null
      const reversal = retainedReversal?.reversal
      const target = retainedReversal?.target
      if (
        root?.status !== 'reversed'
        || target?.status !== 'reversed'
        || !reversal
        || reversal.status !== 'posted'
        || reversal.source_type !== 'storno'
        || reversal.reverses_id !== target.id
        || (
          reversal.committed_at !== null
          && Date.parse(reversal.committed_at) !== Date.parse(row.reversed_at!)
        )
      ) {
        throw new Error(`Malformed supplier payment reversal lineage for ${row.id}`)
      }
    }

    const accountingDatesByRoot = new Map<string, string | null>()
    for (const [rootId, root] of supplierRoots) {
      accountingDatesByRoot.set(
        rootId,
        effectiveAccountingDateAtCutoff(root, supplierLineage, asOfDate),
      )
    }

    const paidThrough = new Map<string, number>()
    const hasRows = new Set<string>()
    for (const rawRow of rows) {
      const row = rawRow as SupplierPaymentRow & Record<string, unknown>
      hasRows.add(row.supplier_invoice_id)
      if (row.journal_entry_id !== null) continue
      if (row.payment_date <= asOfDate) {
        paidThrough.set(
          row.supplier_invoice_id,
          roundOre(
            (paidThrough.get(row.supplier_invoice_id) ?? 0)
            + (Number(row.amount) || 0),
          ),
        )
      }
    }
    for (const [rootId, invoiceAmounts] of supplierAllocationsByRoot) {
      if (!accountingDatesByRoot.get(rootId)) continue
      for (const [invoiceId, amount] of invoiceAmounts) {
        paidThrough.set(
          invoiceId,
          roundOre((paidThrough.get(invoiceId) ?? 0) + amount),
        )
      }
    }
    return { paidThrough, hasRows }
  }

  const paidThrough = new Map<string, number>()
  const hasRows = new Set<string>()

  for (const rawRow of rows) {
    const invoiceId = rawRow[invoiceIdColumn] as string | null
    if (!invoiceId) continue
    hasRows.add(invoiceId)

    const accountingDate = rawRow.payment_date

    if (accountingDate && accountingDate <= asOfDate) {
      const prev = paidThrough.get(invoiceId) ?? 0
      paidThrough.set(invoiceId, roundOre(prev + (Number(rawRow.amount) || 0)))
    }
  }

  return { paidThrough, hasRows }
}

/**
 * An invoice's outstanding amount (in invoice currency) as of the
 * reconstruction date.
 *
 * Priority order:
 * 1. Payment rows exist: they are authoritative. Outstanding is the invoice
 *    total minus the rows dated on or before the as-of date, including the
 *    "all payments came later" case, which reopens the full total.
 * 2. No rows but the invoice is fully paid (`paid_at` set): paid before or on
 *    the as-of date means the live (settled) outstanding stands; paid after
 *    it means the full total was still open.
 * 3. No rows and no `paid_at` (legacy partial payments recorded before the
 *    payment tables carried every settlement): the history cannot be dated,
 *    so the live outstanding is assumed to have stood at the as-of date.
 *    This matches what the live ledger reports for the same rows.
 */
export function outstandingAsOf(
  invoice: { id: string; paid_at?: string | null },
  total: number,
  liveOutstanding: number,
  payments: PaymentsAsOf,
  asOfDate: string
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

/** Local calendar date (YYYY-MM-DD) used to decide whether an as-of date needs
 * historical reconstruction at all. */
export function todayIsoDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
