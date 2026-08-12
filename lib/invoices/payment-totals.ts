import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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
    const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from(table)
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
  }

  return totals
}
