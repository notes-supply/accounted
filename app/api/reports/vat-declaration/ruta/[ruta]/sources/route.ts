import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import {
  ACCOUNT_RUTA,
  createSharedLineageVatConsumer,
  parseVatPeriodInput,
  resolveControlledInputVatProjection,
  resolvePeriodDates,
  type VatControlledInputLineageConsumer,
  type VatPeriodInput,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import type { ReportSourceLine } from '@/lib/reports/source-lines'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { VatDeclarationRutor } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'

/**
 * GET /api/reports/vat-declaration/ruta/[ruta]/sources
 *
 * Returns the journal entry lines that contribute to a single ruta on the
 * VAT declaration. The mapping ruta → BAS accounts is the inverse of
 * `ACCOUNT_RUTA` in `lib/reports/vat-declaration.ts`.
 *
 * Period can be specified either via:
 *   ?periodType=monthly|quarterly|yearly&year=2026&period=5[&fiscal_period_id=<uuid>]
 *   ?fiscal_period_id=<uuid>
 *
 * The periodType form mirrors the way the main VAT report is fetched, down to
 * the period resolution itself: it goes through `resolvePeriodDates`, the same
 * helper the declaration uses, so the drill-down can never answer a query
 * string with a different span than the figure it drills into.
 */
const PAGE_LIMIT = 500
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface SourceRow {
  line_id: string
  journal_entry_id: string
  voucher_number: number
  voucher_series: string | null
  entry_date: string
  description: string | null
  debit_amount: number
  credit_amount: number
}

function compareSourceRows(left: SourceRow, right: SourceRow): number {
  return left.entry_date.localeCompare(right.entry_date)
    || left.voucher_number - right.voucher_number
    || left.journal_entry_id.localeCompare(right.journal_entry_id)
    || left.line_id.localeCompare(right.line_id)
}

function isAfterCursor(
  row: SourceRow,
  cursor: {
    date: string | null
    voucherNumber: number | null
    entryId: string | null
    lineId: string | null
  },
): boolean {
  if (!cursor.date || cursor.voucherNumber === null) return true
  const cursorRow: SourceRow = {
    line_id: cursor.lineId ?? '',
    journal_entry_id: cursor.entryId ?? '',
    voucher_number: cursor.voucherNumber,
    voucher_series: null,
    entry_date: cursor.date,
    description: null,
    debit_amount: 0,
    credit_amount: 0,
  }
  return compareSourceRows(row, cursorRow) > 0
}

async function fetchControlledSourceRows(
  supabase: Parameters<typeof resolveControlledInputVatProjection>[0],
  companyId: string,
  acceptedEntryIds: string[],
  start: string,
  end: string,
): Promise<SourceRow[]> {
  if (acceptedEntryIds.length === 0) return []
  const accepted = new Set(acceptedEntryIds)
  const entries = await fetchAllRows<{
    id: string
    voucher_number: number
    voucher_series: string | null
    entry_date: string
    description: string | null
    vat_lines: Array<{
      id: string
      account_number: string
      debit_amount: number
      credit_amount: number
    }>
  }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select(`
        id, voucher_number, voucher_series, entry_date, description,
        vat_lines:journal_entry_lines!inner(
          id, account_number, debit_amount, credit_amount
        )
      `)
      .eq('company_id', companyId)
      .in('id', acceptedEntryIds)
      .in('status', ['posted', 'reversed'])
      .in('source_type', ['year_end', 'correction', 'storno'])
      .eq('vat_lines.account_number', '2648')
      .order('entry_date', { ascending: true })
      .order('voucher_number', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  const seen = new Set<string>()
  const rows: SourceRow[] = []
  for (const entry of entries) {
    if (
      !accepted.has(entry.id)
      || !Number.isInteger(entry.voucher_number)
      || typeof entry.entry_date !== 'string'
      || !ISO_DATE_RE.test(entry.entry_date)
      || entry.entry_date < start
      || entry.entry_date > end
      || !Array.isArray(entry.vat_lines)
      || entry.vat_lines.length === 0
    ) {
      throw new Error('Controlled ruta 48 source evidence changed')
    }
    seen.add(entry.id)
    for (const line of entry.vat_lines) {
      if (
        line.account_number !== '2648'
        || typeof line.id !== 'string'
        || typeof line.debit_amount !== 'number'
        || !Number.isFinite(line.debit_amount)
        || typeof line.credit_amount !== 'number'
        || !Number.isFinite(line.credit_amount)
      ) {
        throw new Error('Controlled ruta 48 source evidence changed')
      }
      rows.push({
        line_id: line.id,
        journal_entry_id: entry.id,
        voucher_number: entry.voucher_number,
        voucher_series: entry.voucher_series,
        entry_date: entry.entry_date,
        description: entry.description,
        debit_amount: line.debit_amount,
        credit_amount: line.credit_amount,
      })
    }
  }
  if (seen.size !== accepted.size) {
    throw new Error('Controlled ruta 48 source evidence changed')
  }
  return rows
}

export function createVatRutaSourcesGet(
  controlledInputVatConsumer?: VatControlledInputLineageConsumer,
) {
  return withRouteContext<{ params: Promise<{ ruta: string }> }>(
    'report.vat_declaration.ruta_sources',
    async (request, { supabase, companyId }, { params }) => {

  const { ruta: rutaParam } = await params

  const { searchParams } = new URL(request.url)
  const cursor = searchParams.get('cursor')

  // Normalise ruta param to the keyof VatDeclarationRutor (`ruta10`, `ruta48`).
  const rutaKey = (
    rutaParam.startsWith('ruta') ? rutaParam : `ruta${rutaParam}`
  ) as keyof VatDeclarationRutor

  const dynamicVatAccounts = await fetchDynamicVatAccounts(supabase, companyId)

  // Invert the effective mapping. Fixed BAS mappings stay authoritative;
  // explicit treatments add custom accounts only.
  const accountsForRuta = Object.entries(ACCOUNT_RUTA)
    .filter(([, m]) => m.box === rutaKey)
    .map(([acc]) => acc)

  for (const [account, mapping] of dynamicVatAccounts.mappingByAccount) {
    if (ACCOUNT_RUTA[account]) continue
    if (mapping.box === rutaKey) accountsForRuta.push(account)
  }

  if (accountsForRuta.length === 0) {
    return NextResponse.json(
      { error: `Ruta ${rutaParam} har inga underliggande konton` },
      { status: 404 }
    )
  }

  const fiscalPeriodId = searchParams.get('fiscal_period_id')
  let parsed: VatPeriodInput
  try {
    parsed = parseVatPeriodInput({
      periodType: searchParams.get('periodType'),
      year: searchParams.get('year'),
      period: searchParams.get('period'),
      fiscalPeriodId,
    })
  } catch (error) {
    return NextResponse.json(
      { error: getUserErrorMessage(error) },
      { status: 400 },
    )
  }
  const dates = await resolvePeriodDates(
    supabase,
    companyId,
    parsed.periodType,
    parsed.year,
    parsed.period,
    parsed.fiscalPeriodId,
  )
  const { start, end } = dates

  // New cursors include entry and line IDs so multiple rows with the same
  // date and voucher number are paged without gaps. Two-part legacy cursors
  // remain accepted during rolling deployments.
  let cursorDate: string | null = null
  let cursorVoucherNum: number | null = null
  let cursorEntryId: string | null = null
  let cursorLineId: string | null = null
  if (cursor) {
    const parts = cursor.split('|')
    const [cd, cv, ce, cl] = parts
    cursorVoucherNum = parseInt(cv, 10)
    const validShape = parts.length === 2 || parts.length === 4
    const validIds = parts.length === 2 || (UUID_PATTERN.test(ce) && UUID_PATTERN.test(cl))
    if (
      !validShape ||
      !validIds ||
      !cd ||
      !ISO_DATE_RE.test(cd) ||
      isNaN(cursorVoucherNum)
    ) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }
    cursorDate = cd
    cursorEntryId = ce ?? null
    cursorLineId = cl ?? null
  }

  let controlledRows: SourceRow[] = []
  if (rutaKey === 'ruta48') {
    const projection = await resolveControlledInputVatProjection(
      supabase,
      companyId,
      start,
      end,
      controlledInputVatConsumer ?? createSharedLineageVatConsumer(supabase),
    )
    controlledRows = (await fetchControlledSourceRows(
      supabase,
      companyId,
      projection.acceptedEntryIds,
      start,
      end,
    )).filter((row) => isAfterCursor(row, {
      date: cursorDate,
      voucherNumber: cursorVoucherNum,
      entryId: cursorEntryId,
      lineId: cursorLineId,
    }))
    const controlledDebit = roundOre(
      controlledRows.reduce((sum, row) => sum + row.debit_amount, 0),
    )
    const controlledCredit = roundOre(
      controlledRows.reduce((sum, row) => sum + row.credit_amount, 0),
    )
    if (
      cursorDate === null
      && (
        controlledDebit !== projection.debit
        || controlledCredit !== projection.credit
      )
    ) {
      throw new Error('Controlled ruta 48 source evidence changed')
    }
  }

  // The RPC orders and limits at the database. The old PostgREST join loaded
  // every matching line before slicing 500 in JavaScript, which timed out for
  // companies with long VAT histories.
  const { data: rows, error } = await supabase.rpc('get_vat_ruta_source_lines', {
    p_company_id: companyId,
    p_start: start,
    p_end: end,
    p_accounts: accountsForRuta,
    p_cursor_date: cursorDate,
    p_cursor_voucher_number: cursorVoucherNum,
    p_cursor_entry_id: cursorEntryId,
    p_cursor_line_id: cursorLineId,
    p_limit: PAGE_LIMIT + 1,
  })

  if (error) {
    throw Object.assign(new Error(`Failed to fetch VAT source lines: ${error.message}`), {
      code: error.code,
    })
  }

  const ordinaryRows = (rows ?? []) as SourceRow[]
  const combinedRows = [...ordinaryRows, ...controlledRows].sort(compareSourceRows)
  const pageRows = combinedRows.slice(0, PAGE_LIMIT)

  const lines: ReportSourceLine[] = pageRows.map((row) => ({
    journal_entry_id: row.journal_entry_id,
    voucher_number: row.voucher_number,
    voucher_series: row.voucher_series || 'A',
    date: row.entry_date,
    description: row.description || '',
    debit: roundOre(Number(row.debit_amount) || 0),
    credit: roundOre(Number(row.credit_amount) || 0),
  }))

  let next_cursor: string | null = null
  if (combinedRows.length > PAGE_LIMIT && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]
    next_cursor = [
      last.entry_date,
      last.voucher_number,
      last.journal_entry_id,
      last.line_id,
    ].join('|')
  }

  return NextResponse.json({
    data: {
      ruta: rutaKey,
      lines,
      next_cursor,
    },
  })
    },
  )
}

export const GET = createVatRutaSourcesGet()
