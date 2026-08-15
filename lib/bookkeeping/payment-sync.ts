import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookkeepingDatabaseError,
  DurableAccountingConflictError,
  DurableAccountingIdentityError,
  DurableAccountingPartialError,
} from '@/lib/bookkeeping/errors'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type {
  AccountingActor,
  AccountingActorType,
  DurableJournalReversalOutcome,
  DurablePublicationIdentity,
  JournalEntry,
  JournalEntrySourceType,
  SupplierPaymentLineage,
  SupplierPaymentLineageNode,
} from '@/types'

const log = createLogger('payment-sync')

export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

const MAX_CORRECTION_DEPTH = 32
const MAX_TERMINAL_STORNO_DEPTH = 33
const SUPPLIER_PAYMENT_HISTORY_TABLE = 'supplier_invoice_payment_history'

type GenericLineageEdgeKind = 'root' | 'correction' | 'storno'

interface GenericLineageNode {
  root_id: string
  parent_id: string | null
  edge_kind: GenericLineageEdgeKind
  id: string
  company_id: string
  entry_date: string
  status: 'posted' | 'reversed'
  source_type: string
  correction_of_id: string | null
  reverses_id: string | null
  reversed_by_id: string | null
  committed_at: string | null
  depth: number
  path: string[]
  cycle: false
}

interface ParsedGenericLineage {
  rows: GenericLineageNode[]
  liveJournalEntryId: string
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function rpcRow(data: unknown): Record<string, unknown> | null {
  const value = Array.isArray(data) ? data[0] : data
  return objectRecord(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseGenericLineageNode(
  value: unknown,
  companyId: string,
  rootJournalEntryId: string,
): GenericLineageNode | null {
  const node = objectRecord(value)
  if (
    !node ||
    node.root_id !== rootJournalEntryId ||
    !isNullableString(node.parent_id) ||
    (
      node.edge_kind !== 'root' &&
      node.edge_kind !== 'correction' &&
      node.edge_kind !== 'storno'
    ) ||
    typeof node.id !== 'string' ||
    node.id.length === 0 ||
    node.company_id !== companyId ||
    typeof node.entry_date !== 'string' ||
    (node.status !== 'posted' && node.status !== 'reversed') ||
    typeof node.source_type !== 'string' ||
    node.source_type.length === 0 ||
    !isNullableString(node.correction_of_id) ||
    !isNullableString(node.reverses_id) ||
    !isNullableString(node.reversed_by_id) ||
    !isNullableString(node.committed_at) ||
    !isNonNegativeInteger(node.depth) ||
    node.depth > MAX_TERMINAL_STORNO_DEPTH ||
    !Array.isArray(node.path) ||
    !node.path.every((id) => typeof id === 'string' && id.length > 0) ||
    node.cycle !== false
  ) {
    return null
  }
  return node as unknown as GenericLineageNode
}

function parseGenericJournalLineage(
  data: unknown,
  companyId: string,
  rootJournalEntryId: string,
  requestedJournalEntryId: string,
): ParsedGenericLineage | null {
  const envelope = objectRecord(data)
  if (
    !envelope ||
    envelope.valid !== true ||
    envelope.company_id !== companyId ||
    envelope.requested_root_count !== 1 ||
    !isNonNegativeInteger(envelope.row_count) ||
    !isNonNegativeInteger(envelope.max_depth) ||
    !isNonNegativeInteger(envelope.max_correction_depth) ||
    (
      envelope.terminal_storno_depth !== null &&
      !isNonNegativeInteger(envelope.terminal_storno_depth)
    ) ||
    !Array.isArray(envelope.rows) ||
    envelope.rows.length === 0
  ) {
    return null
  }

  const rows: GenericLineageNode[] = []
  for (const value of envelope.rows) {
    const row = parseGenericLineageNode(value, companyId, rootJournalEntryId)
    if (!row) return null
    rows.push(row)
  }

  const ids = new Set(rows.map((row) => row.id))
  const rootRows = rows.filter((row) => row.edge_kind === 'root')
  const maxDepth = Math.max(...rows.map((row) => row.depth))
  const maxCorrectionDepth = Math.max(
    ...rows
      .filter((row) => row.edge_kind !== 'storno')
      .map((row) => row.depth),
  )
  const stornoDepths = rows
    .filter((row) => row.edge_kind === 'storno')
    .map((row) => row.depth)
  const terminalStornoDepth = stornoDepths.length > 0
    ? Math.max(...stornoDepths)
    : null
  if (
    ids.size !== rows.length ||
    rootRows.length !== 1 ||
    rootRows[0]!.id !== rootJournalEntryId ||
    envelope.row_count !== rows.length ||
    envelope.max_depth !== maxDepth ||
    envelope.max_correction_depth !== maxCorrectionDepth ||
    envelope.terminal_storno_depth !== terminalStornoDepth
  ) {
    return null
  }

  const byId = new Map(rows.map((row) => [row.id, row]))
  const correctionChildren = new Map<string, GenericLineageNode[]>()
  const stornoChildren = new Map<string, GenericLineageNode[]>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (
      row.path.length !== row.depth + 1 ||
      row.path[0] !== rootJournalEntryId ||
      row.path[row.path.length - 1] !== row.id ||
      (index > 0 && rows[index - 1]!.depth > row.depth)
    ) {
      return null
    }

    if (row.edge_kind === 'root') {
      if (
        row.parent_id !== null ||
        row.id !== rootJournalEntryId ||
        row.depth !== 0 ||
        row.path.length !== 1 ||
        row.source_type === 'correction' ||
        row.source_type === 'storno' ||
        row.correction_of_id !== null ||
        row.reverses_id !== null
      ) {
        return null
      }
      continue
    }

    const parent = row.parent_id ? byId.get(row.parent_id) : null
    if (
      !parent ||
      parent.edge_kind === 'storno' ||
      row.depth !== parent.depth + 1 ||
      row.path.length !== parent.path.length + 1 ||
      !parent.path.every((id, pathIndex) => row.path[pathIndex] === id)
    ) {
      return null
    }

    const children = row.edge_kind === 'correction'
      ? correctionChildren
      : stornoChildren
    children.set(parent.id, [...(children.get(parent.id) ?? []), row])
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
      return null
    }
  }

  for (const row of rows) {
    const corrections = correctionChildren.get(row.id) ?? []
    const stornos = stornoChildren.get(row.id) ?? []
    if (
      corrections.length > 1 ||
      stornos.length > 1 ||
      (row.edge_kind === 'storno' && (corrections.length > 0 || stornos.length > 0))
    ) {
      return null
    }
    if (row.edge_kind !== 'storno') {
      if (
        (
          row.status === 'posted' &&
          (row.reversed_by_id !== null || stornos.length !== 0)
        ) ||
        (
          row.status === 'reversed' &&
          (stornos.length !== 1 || row.reversed_by_id !== stornos[0]!.id)
        ) ||
        (corrections.length === 1 && row.status !== 'reversed')
      ) {
        return null
      }
    }
  }

  let live = rootRows[0]!
  while ((correctionChildren.get(live.id) ?? []).length === 1) {
    live = correctionChildren.get(live.id)![0]!
  }
  if (
    !byId.has(requestedJournalEntryId) ||
    live.id !== requestedJournalEntryId
  ) {
    return null
  }
  return { rows, liveJournalEntryId: live.id }
}

function invalidLineageIdentity(
  companyId: string,
  requestedJournalEntryId: string,
  detail: string,
): DurableAccountingIdentityError {
  return new DurableAccountingIdentityError(
    'resolve_supplier_payment_lineage',
    {
      company_id: companyId,
      original_journal_entry_id: requestedJournalEntryId,
      reversal_journal_entry_id: null,
      publication_ids: [],
    },
    detail,
  )
}

async function resolveLineageRootId(
  supabase: SupabaseClient,
  companyId: string,
  requestedJournalEntryId: string,
): Promise<string> {
  const seen = new Set<string>()
  let entryId = requestedJournalEntryId
  for (let depth = 0; depth <= MAX_CORRECTION_DEPTH; depth += 1) {
    if (seen.has(entryId)) {
      throw invalidLineageIdentity(
        companyId,
        requestedJournalEntryId,
        'journal correction ancestry contains a cycle',
      )
    }
    seen.add(entryId)
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, company_id, source_type, correction_of_id')
      .eq('company_id', companyId)
      .eq('id', entryId)
      .maybeSingle()
    if (error) {
      throw new BookkeepingDatabaseError(
        'resolve_supplier_payment_lineage',
        error.message,
      )
    }
    const row = objectRecord(data)
    if (
      !row ||
      row.id !== entryId ||
      row.company_id !== companyId ||
      typeof row.source_type !== 'string' ||
      !isNullableString(row.correction_of_id)
    ) {
      throw invalidLineageIdentity(
        companyId,
        requestedJournalEntryId,
        'journal correction ancestry was missing or malformed',
      )
    }
    if (row.source_type !== 'correction') {
      if (
        row.source_type === 'storno' ||
        row.correction_of_id !== null
      ) {
        throw invalidLineageIdentity(
          companyId,
          requestedJournalEntryId,
          'journal correction ancestry did not resolve to a true root',
        )
      }
      return row.id as string
    }
    if (typeof row.correction_of_id !== 'string' || depth === MAX_CORRECTION_DEPTH) {
      throw invalidLineageIdentity(
        companyId,
        requestedJournalEntryId,
        'journal correction ancestry exceeded the M2 depth bound',
      )
    }
    entryId = row.correction_of_id
  }
  throw invalidLineageIdentity(
    companyId,
    requestedJournalEntryId,
    'journal correction ancestry exceeded the M2 depth bound',
  )
}

interface AllocationOwnershipRow {
  id: string
  journal_entry_id: string
}

function parseAllocationOwnershipRows(
  data: unknown,
  lineageEntryIds: Set<string>,
): AllocationOwnershipRow[] | null {
  if (!Array.isArray(data)) return null
  const rows: AllocationOwnershipRow[] = []
  for (const value of data) {
    const row = objectRecord(value)
    if (
      !row ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.journal_entry_id !== 'string' ||
      !lineageEntryIds.has(row.journal_entry_id)
    ) {
      return null
    }
    rows.push(row as unknown as AllocationOwnershipRow)
  }
  return rows
}

function isPublicationIdentity(value: unknown): value is DurablePublicationIdentity {
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

function isAccountingActorType(value: unknown): value is AccountingActorType {
  return (
    value === 'user' ||
    value === 'api_key' ||
    value === 'mcp_oauth' ||
    value === 'cron' ||
    value === 'system' ||
    value === 'agent_chat'
  )
}

function parseSupplierPaymentReversalOutcome(
  data: unknown,
  companyId: string,
  lineage: SupplierPaymentLineage,
): DurableJournalReversalOutcome | null {
  const row = rpcRow(data)
  if (
    !row ||
    (row.status !== 'applied' && row.status !== 'already_applied') ||
    row.company_id !== companyId ||
    row.root_journal_entry_id !== lineage.root_journal_entry_id ||
    row.original_journal_entry_id !== lineage.requested_journal_entry_id ||
    typeof row.reversal_journal_entry_id !== 'string' ||
    row.reversal_journal_entry_id.length === 0 ||
    !isAccountingActorType(row.actor_type) ||
    (row.actor_id !== null && typeof row.actor_id !== 'string') ||
    (row.actor_label !== null && typeof row.actor_label !== 'string') ||
    !Array.isArray(row.publications) ||
    row.publications.length !== 2 ||
    !row.publications.every(isPublicationIdentity)
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
  return row as unknown as DurableJournalReversalOutcome
}

export async function resolveSupplierPaymentLineage(
  supabase: SupabaseClient,
  companyId: string,
  requestedJournalEntryId: string,
): Promise<SupplierPaymentLineage> {
  const rootJournalEntryId = await resolveLineageRootId(
    supabase,
    companyId,
    requestedJournalEntryId,
  )
  const { data, error } = await supabase.rpc('get_journal_lineage', {
    p_company_id: companyId,
    p_root_ids: [rootJournalEntryId],
  })
  if (error) {
    throw new BookkeepingDatabaseError(
      'resolve_supplier_payment_lineage',
      error.message,
    )
  }
  const lineage = parseGenericJournalLineage(
    data,
    companyId,
    rootJournalEntryId,
    requestedJournalEntryId,
  )
  if (!lineage) {
    throw invalidLineageIdentity(
      companyId,
      requestedJournalEntryId,
      'M2 generic lineage RPC returned an invalid company-scoped envelope',
    )
  }

  const nonStornoEntryIds = lineage.rows
    .filter((node) => node.edge_kind !== 'storno')
    .map((node) => node.id)
  const lineageEntryIds = new Set(nonStornoEntryIds)
  const [activeResponse, historyResponse] = await Promise.all([
    supabase
      .from('supplier_invoice_payments')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', nonStornoEntryIds),
    supabase
      .from(SUPPLIER_PAYMENT_HISTORY_TABLE)
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', nonStornoEntryIds),
  ])
  if (activeResponse.error || historyResponse.error) {
    throw new BookkeepingDatabaseError(
      'resolve_supplier_payment_lineage',
      activeResponse.error?.message ??
        historyResponse.error?.message ??
        'supplier allocation ownership read failed',
    )
  }
  const activeAllocations = parseAllocationOwnershipRows(
    activeResponse.data,
    lineageEntryIds,
  )
  const historicalAllocations = parseAllocationOwnershipRows(
    historyResponse.data,
    lineageEntryIds,
  )
  if (!activeAllocations || !historicalAllocations) {
    throw invalidLineageIdentity(
      companyId,
      requestedJournalEntryId,
      'supplier allocation ownership evidence was malformed',
    )
  }

  const allocationIds = new Set<string>()
  const allocationOwnerIds = new Set<string>()
  for (const allocation of [...activeAllocations, ...historicalAllocations]) {
    if (allocationIds.has(allocation.id)) {
      throw invalidLineageIdentity(
        companyId,
        requestedJournalEntryId,
        'supplier allocation appeared in both active and immutable history',
      )
    }
    allocationIds.add(allocation.id)
    allocationOwnerIds.add(allocation.journal_entry_id)
  }
  if (allocationOwnerIds.size > 1) {
    throw invalidLineageIdentity(
      companyId,
      requestedJournalEntryId,
      'supplier allocations had multiple journal entry owners',
    )
  }

  const allocationOwnerJournalEntryId =
    allocationOwnerIds.values().next().value ?? null
  const requestedNode = lineage.rows.find(
    (node) => node.id === requestedJournalEntryId,
  )!
  if (
    allocationOwnerJournalEntryId !== null &&
    allocationOwnerJournalEntryId !== rootJournalEntryId &&
    !(
      requestedNode.edge_kind === 'correction' &&
      allocationOwnerJournalEntryId === requestedJournalEntryId
    )
  ) {
    throw invalidLineageIdentity(
      companyId,
      requestedJournalEntryId,
      'supplier allocation owner was neither the lineage root nor the requested correction',
    )
  }

  const rootNode = lineage.rows.find(
    (node) => node.id === rootJournalEntryId,
  )!
  const nodes: SupplierPaymentLineageNode[] = lineage.rows.map((node) => ({
    journal_entry_id: node.id,
    parent_journal_entry_id: node.parent_id,
    relation: node.edge_kind,
    depth: node.depth,
    source_type: node.source_type as JournalEntrySourceType,
    has_supplier_payment_allocation:
      node.id === allocationOwnerJournalEntryId,
  }))
  return {
    company_id: companyId,
    requested_journal_entry_id: requestedJournalEntryId,
    root_journal_entry_id: rootJournalEntryId,
    live_journal_entry_id: lineage.liveJournalEntryId,
    allocation_owner_journal_entry_id: allocationOwnerJournalEntryId,
    is_supplier_payment:
      allocationOwnerJournalEntryId !== null ||
      rootNode.source_type === 'supplier_invoice_paid' ||
      rootNode.source_type === 'supplier_invoice_cash_payment',
    nodes,
  }
}

function assertSupplierPaymentReversalLineage(
  companyId: string,
  requestedJournalEntryId: string,
  lineage: SupplierPaymentLineage,
): void {
  const value = objectRecord(lineage)
  const rootJournalEntryId = value?.root_journal_entry_id
  const nodeIds = new Set(
    Array.isArray(value?.nodes)
      ? value.nodes
        .map((node) => objectRecord(node)?.journal_entry_id)
        .filter((id): id is string => typeof id === 'string')
      : [],
  )
  if (
    value?.company_id !== companyId ||
    value.requested_journal_entry_id !== requestedJournalEntryId ||
    value.live_journal_entry_id !== requestedJournalEntryId ||
    typeof rootJournalEntryId !== 'string' ||
    rootJournalEntryId.length === 0 ||
    !nodeIds.has(rootJournalEntryId) ||
    !nodeIds.has(requestedJournalEntryId)
  ) {
    throw new DurableAccountingIdentityError(
      'apply_supplier_payment_reversal',
      {
        company_id: companyId,
        original_journal_entry_id: requestedJournalEntryId,
        reversal_journal_entry_id: null,
        publication_ids: [],
      },
      'supplier payment lineage contradicts the requested reversal identity',
    )
  }
}

export async function applySupplierPaymentReversal(
  supabase: SupabaseClient,
  params: {
    companyId: string
    requestedJournalEntryId: string
    reversalDate: string
    actor: AccountingActor
    lineage: SupplierPaymentLineage
  },
): Promise<DurableJournalReversalOutcome> {
  assertSupplierPaymentReversalLineage(
    params.companyId,
    params.requestedJournalEntryId,
    params.lineage,
  )
  const rpcArgs = {
    p_company_id: params.companyId,
    p_root_journal_entry_id: params.lineage.root_journal_entry_id,
    p_original_journal_entry_id: params.requestedJournalEntryId,
    p_reversal_date: params.reversalDate,
    p_actor_type: params.actor.actor_type,
    p_actor_id: params.actor.actor_id,
    p_actor_label: params.actor.actor_label,
  }
  let data: unknown = null
  let lastError: { message: string } | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await supabase.rpc('apply_supplier_payment_reversal', rpcArgs)
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
      'apply_supplier_payment_reversal',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.requestedJournalEntryId,
        reversal_journal_entry_id: null,
        publication_ids: [],
      },
      lastError.message,
    )
  }

  const row = rpcRow(data)
  if (row?.status === 'conflict') {
    throw new DurableAccountingConflictError(
      'apply_supplier_payment_reversal',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.requestedJournalEntryId,
        reversal_journal_entry_id:
          typeof row.reversal_journal_entry_id === 'string'
            ? row.reversal_journal_entry_id
            : null,
        publication_ids: [],
      },
      typeof row.reason === 'string' ? row.reason : 'persisted state differs',
    )
  }

  const outcome = parseSupplierPaymentReversalOutcome(
    data,
    params.companyId,
    params.lineage,
  )
  if (!outcome) {
    const publications = Array.isArray(row?.publications)
      ? row.publications.filter(isPublicationIdentity)
      : []
    throw new DurableAccountingIdentityError(
      'apply_supplier_payment_reversal',
      {
        company_id: params.companyId,
        original_journal_entry_id: params.requestedJournalEntryId,
        reversal_journal_entry_id:
          typeof row?.reversal_journal_entry_id === 'string'
            ? row.reversal_journal_entry_id
            : null,
        publication_ids: publications.map(
          (publication) => publication.publication_id,
        ),
      },
      'M3 reversal RPC returned malformed or contradictory identities',
    )
  }
  return outcome
}

/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * that a payment journal entry was attached to. Used by both reverseEntry()
 * (storno) and the DELETE journal entry route: both paths leave the GL in a
 * consistent state but the invoice's status/paid_amount/paid_at would otherwise
 * stay stuck on "paid".
 *
 * Safe to call with any entry: returns early if source_type is not a payment.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
): Promise<void> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return

  const entryId = entry.id

  if (entry.source_type.startsWith('supplier_invoice')) {
    throw new BookkeepingDatabaseError(
      'apply_supplier_payment_reversal',
      'supplier payments must be reversed through the atomic M3 command',
    )
  } else {
    // Scoped like the supplier branch: filter by invoice_id + company_id so a
    // batch voucher's sibling payment rows don't break the .single().
    const { data: payment } = await supabase
      .from('invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    const { data: customerInvoice } = await supabase
      .from('invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (customerInvoice) {
      // For a partial reversal we take the exact amount from the payment row.
      // The fallback (full paid_amount) only applies when no payment row exists:
      // true for invoice_cash_payment, which is only ever booked on a FULL
      // payment, so reverting the whole paid_amount is correct there. Guarding
      // this keeps a future partial-cash path from over-reverting.
      const paymentAmount = payment?.amount ?? customerInvoice.paid_amount
      const newPaidAmount = roundOre(customerInvoice.paid_amount - paymentAmount)
      const safePaidAmount = Math.max(0, newPaidAmount)
      // The supplier branch already resets remaining_amount; the customer branch
      // never did, leaving it stale (= total) after a reversal so the invoice
      // showed fully unpaid yet stuck on 'paid'. Recompute from total. (The
      // .in('status', …) guard below can leave status/remaining un-updated if
      // the invoice isn't paid/partially_paid: only reachable on a non-storno
      // path; the payment-row delete + tx release still run, freeing the line.)
      const newRemaining = roundOre(customerInvoice.total - safePaidAmount)
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      await supabase
        .from('invoices')
        .update({
          status: revertStatus,
          paid_at: null,
          paid_amount: safePaidAmount,
          remaining_amount: newRemaining,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
        .in('status', ['paid', 'partially_paid'])
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't trip the (transaction_id,
    // invoice_id) / (journal_entry_id, invoice_id) unique indexes on
    // invoice_payments. Scoped to the source invoice: see the supplier
    // branch comment for the batch-voucher rationale.
    const { data: ipRows } = await supabase
      .from('invoice_payments')
      .select('transaction_id')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await supabase
      .from('invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await releaseLinkedTransactions(
      supabase,
      companyId,
      entryId,
      (ipRows ?? []).map((r) => (r as { transaction_id: string | null }).transaction_id),
      'invoice_id',
    )
  }
}

/**
 * Detach any bank transactions still pointing at a reversed payment voucher so
 * the bank line returns to the inbox and becomes re-matchable. Without this, a
 * standalone storno (the reverse route / MCP reverse tool / delete-last-voucher)
 * leaves transactions.journal_entry_id pointing at a reversed JE: the match
 * POST refuses (invoice no longer matchable once we also fix its status) and the
 * line can't be re-booked or deleted. The match-invoice route already clears the
 * tx when IT stornos a conflicting auto-categorization JE; this covers every
 * other reversal path.
 *
 * Clears by journal_entry_id (covers the link even when the payment row was
 * missing) and by the captured payment-row transaction ids (covers a partial
 * match that cleared journal_entry_id but left invoice_id/category set). Only
 * the link/categorization columns are reset; the transaction row is preserved.
 */
async function releaseLinkedTransactions(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  paymentTransactionIds: Array<string | null>,
  invoiceColumn: 'invoice_id' | 'supplier_invoice_id',
): Promise<void> {
  const resetFields = {
    journal_entry_id: null,
    [invoiceColumn]: null,
    is_business: null,
    category: null,
  }

  const { data: releasedByEntry, error: byEntryError } = await supabase
    .from('transactions')
    .update(resetFields)
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .select('id')
  if (byEntryError) {
    // Best-effort like the rest of the sync: the storno itself already
    // committed, but a failed release leaves the bank line stuck on a
    // reversed JE, so it must be observable.
    log.error('Failed to release transactions by journal_entry_id', byEntryError, {
      companyId,
      journalEntryId: entryId,
    })
  } else if (releasedByEntry && releasedByEntry.length > 0) {
    // transactions has no write_audit_log trigger, so the clearing of the
    // link/categorization columns is logged here for incident reconstruction.
    log.info('Released bank transactions from reversed payment voucher', {
      companyId,
      journalEntryId: entryId,
      invoiceColumn,
      transactionIds: releasedByEntry.map((r) => (r as { id: string }).id),
    })
  }

  const txIds = paymentTransactionIds.filter((id): id is string => !!id)
  if (txIds.length > 0) {
    const { data: releasedById, error: byIdError } = await supabase
      .from('transactions')
      .update(resetFields)
      .eq('company_id', companyId)
      .in('id', txIds)
      .select('id')
    if (byIdError) {
      log.error('Failed to release transactions by payment transaction ids', byIdError, {
        companyId,
        journalEntryId: entryId,
        transactionIds: txIds,
      })
    } else if (releasedById && releasedById.length > 0) {
      log.info('Released payment-linked bank transactions from reversed voucher', {
        companyId,
        journalEntryId: entryId,
        invoiceColumn,
        transactionIds: releasedById.map((r) => (r as { id: string }).id),
      })
    }
  }
}
