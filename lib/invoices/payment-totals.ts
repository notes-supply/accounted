import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  effectiveAccountingDateAtCutoff,
  fetchSupplierJournalLineage,
} from '@/lib/reports/reskontra-payments'

const PARENT_ID_CHUNK_SIZE = 500

type PaymentTable = 'invoice_payments' | 'supplier_invoice_payments'
type ParentColumn = 'invoice_id' | 'supplier_invoice_id'

interface PaymentTotalOptions {
  supabase: SupabaseClient
  table: PaymentTable
  parentColumn: ParentColumn
  companyId: string
  parentIds: string[]
  throughDate: string
}

interface SupplierPaymentRow {
  id: string
  supplier_invoice_id: string
  amount: number | string | null
  payment_date: string
  journal_entry_id: string | null
}

/**
 * Sum payment amounts, in each invoice's own currency, through an as-of date.
 * Parent IDs are chunked to keep PostgREST filters bounded; each chunk is also
 * paginated because one invoice can have many partial payments.
 */
export async function fetchPaymentTotalsByParent({
  supabase,
  table,
  parentColumn,
  companyId,
  parentIds,
  throughDate,
}: PaymentTotalOptions): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  const uniqueIds = Array.from(new Set(parentIds))

  for (let i = 0; i < uniqueIds.length; i += PARENT_ID_CHUNK_SIZE) {
    const parentIdChunk = uniqueIds.slice(i, i + PARENT_ID_CHUNK_SIZE)
    if (table === 'invoice_payments') {
      const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
        supabase
          .from('invoice_payments')
          .select(`id, ${parentColumn}, amount`)
          .eq('company_id', companyId)
          .lte('payment_date', throughDate)
          .in(parentColumn, parentIdChunk)
          .order('id', { ascending: true })
          .range(from, to),
      )

      for (const row of rows) {
        const parentId = row[parentColumn]
        if (typeof parentId !== 'string') continue
        totals.set(parentId, (totals.get(parentId) ?? 0) + Number(row.amount ?? 0))
      }
      continue
    }

    const rows = await fetchAllRows<SupplierPaymentRow>(({ from, to }) =>
      supabase
        .from('supplier_invoice_payments')
        .select('id, supplier_invoice_id, amount, payment_date, journal_entry_id')
        .eq('company_id', companyId)
        .in('supplier_invoice_id', parentIdChunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    const allocationsByRoot = new Map<string, Map<string, number>>()

    for (const row of rows) {
      if (typeof row.supplier_invoice_id !== 'string') continue
      if (row.journal_entry_id === null) {
        if (row.payment_date <= throughDate) {
          totals.set(
            row.supplier_invoice_id,
            (totals.get(row.supplier_invoice_id) ?? 0) + Number(row.amount ?? 0),
          )
        }
        continue
      }
      if (typeof row.journal_entry_id !== 'string') {
        throw new Error(`Malformed supplier payment journal link for ${row.id}`)
      }

      const invoiceAmounts = allocationsByRoot.get(row.journal_entry_id)
        ?? new Map<string, number>()
      invoiceAmounts.set(
        row.supplier_invoice_id,
        (invoiceAmounts.get(row.supplier_invoice_id) ?? 0) + Number(row.amount ?? 0),
      )
      allocationsByRoot.set(row.journal_entry_id, invoiceAmounts)
    }

    const lineage = await fetchSupplierJournalLineage(
      supabase,
      companyId,
      Array.from(allocationsByRoot.keys()),
    )
    for (const [rootId, invoiceAmounts] of allocationsByRoot) {
      const root = lineage.roots.get(rootId)
      if (!root) {
        throw new Error(`Could not resolve supplier payment journal entry ${rootId}`)
      }
      if (!effectiveAccountingDateAtCutoff(root, lineage, throughDate)) continue

      for (const [invoiceId, amount] of invoiceAmounts) {
        totals.set(invoiceId, (totals.get(invoiceId) ?? 0) + amount)
      }
    }
  }

  return totals
}
