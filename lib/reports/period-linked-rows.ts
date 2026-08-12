import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const ENTRY_ID_CHUNK_SIZE = 500

type LinkedTable = 'invoices' | 'supplier_invoices'
type EntryLinkColumn = 'journal_entry_id' | 'registration_journal_entry_id'

interface PeriodLinkedRowsOptions {
  supabase: SupabaseClient
  table: LinkedTable
  select: string
  entryLinkColumn: EntryLinkColumn
  companyId: string
  throughDate: string
}

/**
 * Fetch invoice rows whose registration voucher existed by a period end.
 * The two-step query avoids PostgREST embedded-filter plans and keeps both the
 * entry and invoice populations complete through stable paging and ID chunks.
 */
export async function fetchPeriodLinkedRows<T extends { id?: unknown }>({
  supabase,
  table,
  select,
  entryLinkColumn,
  companyId,
  throughDate,
}: PeriodLinkedRowsOptions): Promise<T[]> {
  const rows = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from(table)
        .select(`${select}, ${entryLinkColumn}`)
        .eq('company_id', companyId)
        .lte('invoice_date', throughDate)
        .not(entryLinkColumn, 'is', null)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null
          error: { message: string } | null
        }>,
  )

  const entryIds = Array.from(new Set(rows
    .map((row) => row[entryLinkColumn])
    .filter((entryId): entryId is string => typeof entryId === 'string')))
  const eligibleEntryIds = new Set<string>()

  for (let i = 0; i < entryIds.length; i += ENTRY_ID_CHUNK_SIZE) {
    const entryIdChunk = entryIds.slice(i, i + ENTRY_ID_CHUNK_SIZE)
    const entries = await fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .lte('entry_date', throughDate)
        .in('status', ['posted', 'reversed'])
        .in('id', entryIdChunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const entry of entries) eligibleEntryIds.add(entry.id)
  }

  return rows.filter((row) => {
    const entryId = row[entryLinkColumn]
    return typeof entryId === 'string' && eligibleEntryIds.has(entryId)
  }) as T[]
}
