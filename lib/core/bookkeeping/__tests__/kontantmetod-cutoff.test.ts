import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  reverseEntry: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn(),
}))

vi.mock('@/lib/invoices/payment-totals', () => ({
  fetchPaymentTotalsByParent: vi.fn(),
}))

import {
  buildCutoffLines,
  buildCutoffNote,
  collectKontantmetodCutoff,
  distributeOre,
  postKontantmetodCutoff,
  nextDay,
  reverseLines,
  VILANDE_INPUT_VAT_ACCOUNT,
  VILANDE_OUTPUT_VAT_ACCOUNTS,
} from '../kontantmetod-cutoff'
import type { CutoffPayable, CutoffReceivable } from '../kontantmetod-cutoff'
import { roundOre } from '@/lib/money'
import { createJournalEntry, findFiscalPeriod, reverseEntry } from '@/lib/bookkeeping/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchPaymentTotalsByParent } from '@/lib/invoices/payment-totals'
import { rutorFromTotals } from '@/lib/reports/vat-declaration'
import { createSupplierInvoiceCashEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { makeSupplierInvoice } from '@/tests/helpers'

const sum = (lines: Array<{ debit_amount: number; credit_amount: number }>) => ({
  debit: roundOre(lines.reduce((s, l) => s + l.debit_amount, 0)),
  credit: roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)),
})

const receivable = (over: Partial<CutoffReceivable> = {}): CutoffReceivable => ({
  id: 'inv-1',
  reference: 'F-1',
  vatTreatment: 'standard_25',
  outstanding: 1250,
  vat: 250,
  ...over,
})

const payable = (over: Partial<CutoffPayable> = {}): CutoffPayable => ({
  id: 'si-1',
  reference: 'L-1',
  outstanding: 1250,
  vat: 250,
  netByAccount: [{ account: '5410', amount: 1000 }],
  ...over,
})

const supplierDocument = (over: Record<string, unknown> = {}) => ({
  id: 'si-original',
  supplier_invoice_number: 'L-1',
  status: 'registered',
  reversed_at: null,
  total: 1250,
  total_sek: 1250,
  vat_amount: 250,
  vat_amount_sek: 250,
  reverse_charge: false,
  is_credit_note: false,
  credited_invoice_id: null,
  items: [{ sort_order: 0, account_number: '5410', line_total: 1000 }],
  ...over,
})
const sourceJournalEntry = (
  sourceId: string,
  over: Record<string, unknown> = {},
) => ({
  id: `je-${sourceId}`,
  source_id: sourceId,
  source_type: 'supplier_invoice_registered',
  status: 'posted',
  entry_date: '2025-06-30',
  correction_of_id: null,
  reverses_id: null,
  committed_at: '2026-01-15T10:00:00Z',
  ...over,
})

const correctionEntry = (
  parentId: string,
  entryDate: string,
  over: Record<string, unknown> = {},
) => sourceJournalEntry('', {
  id: `correction-${parentId}-${entryDate}`,
  source_id: null,
  source_type: 'correction',
  entry_date: entryDate,
  correction_of_id: parentId,
  ...over,
})

const stornoEntry = (
  parentId: string,
  entryDate: string,
  over: Record<string, unknown> = {},
) => sourceJournalEntry('', {
  id: `storno-${parentId}-${entryDate}`,
  source_id: null,
  source_type: 'storno',
  entry_date: entryDate,
  reverses_id: parentId,
  ...over,
})

beforeEach(() => {
  vi.mocked(fetchAllRows).mockReset().mockResolvedValue([])
  vi.mocked(fetchPaymentTotalsByParent).mockReset().mockResolvedValue(new Map())
  vi.mocked(findFiscalPeriod).mockReset().mockResolvedValue('period-2026')
})

function mockSupplierCollection(
  supplierRows: Array<Record<string, unknown>>,
  bookedSourceIds: string[] = [],
) {
  vi.mocked(fetchAllRows)
    .mockResolvedValueOnce([]) // customer documents
    .mockResolvedValueOnce(supplierRows)
    .mockResolvedValueOnce(bookedSourceIds.map((sourceId) =>
      sourceJournalEntry(sourceId)
    ))
    .mockResolvedValueOnce([]) // eligible supplier payment rows
    .mockResolvedValueOnce([]) // eligible supplier payment voucher roots
}

function mockSupplierLineage(options: {
  supplierRows?: Array<Record<string, unknown>>
  paymentRows?: Array<Record<string, unknown>>
  sourceRoots?: Array<Record<string, unknown>>
  linkedRoots?: Array<Record<string, unknown>>
  paymentVoucherRoots?: Array<Record<string, unknown>>
  lineageWaves?: Array<{
    corrections: Array<Record<string, unknown>>
    reversals: Array<Record<string, unknown>>
  }>
}) {
  const paymentRows = options.paymentRows ?? []
  const linkedIds = paymentRows.some((row) => row.journal_entry_id)
  const sourceRoots = options.sourceRoots ?? []
  const waves = options.lineageWaves ?? []
  vi.mocked(fetchAllRows)
    .mockResolvedValueOnce([]) // customer documents
    .mockResolvedValueOnce(options.supplierRows ?? [supplierDocument()])
    .mockResolvedValueOnce(sourceRoots)

  if (sourceRoots.some((root) => root.status === 'reversed')) {
    for (const wave of waves) {
      vi.mocked(fetchAllRows)
        .mockResolvedValueOnce(wave.corrections)
        .mockResolvedValueOnce(wave.reversals)
    }
  }

  vi.mocked(fetchAllRows).mockResolvedValueOnce(paymentRows)
  if (linkedIds) {
    vi.mocked(fetchAllRows).mockResolvedValueOnce(options.linkedRoots ?? [])
  }
  vi.mocked(fetchAllRows).mockResolvedValueOnce(options.paymentVoucherRoots ?? [])

  if (!sourceRoots.some((root) => root.status === 'reversed')) {
    for (const wave of waves) {
      vi.mocked(fetchAllRows)
        .mockResolvedValueOnce(wave.corrections)
        .mockResolvedValueOnce(wave.reversals)
    }
  }
}



describe('collectKontantmetodCutoff', () => {
  it('scales foreign-currency outstanding amounts in SEK without mixing units', async () => {
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([
        {
          id: 'inv-eur',
          invoice_number: 'F-EUR',
          total: 1000,
          total_sek: 11500,
          vat_amount: 200,
          vat_amount_sek: 2300,
          vat_treatment: 'standard_25',
          credited_invoice_id: null,
          document_type: 'invoice',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    vi.mocked(fetchPaymentTotalsByParent)
      .mockResolvedValueOnce(new Map([['inv-eur', 500]]))
      .mockResolvedValueOnce(new Map())

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables).toEqual([
      expect.objectContaining({
        id: 'inv-eur',
        outstanding: 5750,
        vat: 1150,
      }),
    ])
  })

  it('preserves mixed VAT rates and frozen revenue accounts in the cut-off', async () => {
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([
        {
          id: 'inv-mixed',
          invoice_number: 'F-MIX',
          total: 2370,
          total_sek: 2370,
          vat_amount: 370,
          vat_amount_sek: 370,
          vat_treatment: 'standard_25',
          journal_entry_id: null,
          credited_invoice_id: null,
          document_type: 'invoice',
          items: [
            { sort_order: 0, line_total: 1000, vat_rate: 25, vat_amount: 250, revenue_account: '3041' },
            { sort_order: 1, line_total: 1000, vat_rate: 12, vat_amount: 120, revenue_account: null },
          ],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    vi.mocked(fetchPaymentTotalsByParent)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map())

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )
    const { receivableLines } = buildCutoffLines(result.receivables, [])

    expect(receivableLines.find((line) => line.account_number === '3041')?.credit_amount).toBe(1000)
    expect(receivableLines.find((line) => line.account_number === '3002')?.credit_amount).toBe(1000)
    expect(receivableLines.find((line) => line.account_number === '2618')?.credit_amount).toBe(250)
    expect(receivableLines.find((line) => line.account_number === '2628')?.credit_amount).toBe(120)
    expect(sum(receivableLines)).toEqual({ debit: 2370, credit: 2370 })
  })

  it('nets an unbooked credit note with its original before building fixed-side lines', async () => {
    const originalItems = [
      { sort_order: 0, line_total: 1000, vat_rate: 25, vat_amount: 250, revenue_account: '3041' },
    ]
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([
        {
          id: 'inv-original',
          invoice_number: 'F-1',
          status: 'credited',
          total: 1250,
          total_sek: 1250,
          vat_amount: 250,
          vat_amount_sek: 250,
          vat_treatment: 'standard_25',
          journal_entry_id: null,
          credited_invoice_id: null,
          document_type: 'invoice',
          items: originalItems,
        },
        {
          id: 'inv-credit',
          invoice_number: 'KR-F-1',
          status: 'sent',
          total: -1250,
          total_sek: -1250,
          vat_amount: -250,
          vat_amount_sek: -250,
          vat_treatment: 'standard_25',
          journal_entry_id: null,
          credited_invoice_id: 'inv-original',
          document_type: 'invoice',
          items: [
            { sort_order: 0, line_total: -1000, vat_rate: 25, vat_amount: -250, revenue_account: null },
          ],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    vi.mocked(fetchPaymentTotalsByParent)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map())

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables).toHaveLength(2)
    expect(buildCutoffLines(result.receivables, []).receivableLines).toEqual([])
  })

  it('excludes a credit note already represented by a posted source voucher', async () => {
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([
        {
          id: 'inv-original',
          invoice_number: 'F-1',
          status: 'credited',
          total: 1250,
          total_sek: 1250,
          vat_amount: 250,
          vat_amount_sek: 250,
          vat_treatment: 'standard_25',
          journal_entry_id: null,
          credited_invoice_id: null,
          document_type: 'invoice',
          items: [{ sort_order: 0, line_total: 1000, vat_rate: 25, vat_amount: 250 }],
        },
        {
          id: 'inv-credit',
          invoice_number: 'KR-F-1',
          status: 'sent',
          total: -1250,
          total_sek: -1250,
          vat_amount: -250,
          vat_amount_sek: -250,
          vat_treatment: 'standard_25',
          journal_entry_id: null,
          credited_invoice_id: 'inv-original',
          document_type: 'invoice',
          items: [{ sort_order: 0, line_total: -1000, vat_rate: 25, vat_amount: -250 }],
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sourceJournalEntry('inv-credit')])
    vi.mocked(fetchPaymentTotalsByParent)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map())

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables.map((row) => row.id)).toEqual(['inv-original'])
    expect(buildCutoffLines(result.receivables, []).receivableTotal).toBe(1250)
  })

  it('keeps a credit note in a historical cutoff when its source voucher is later', async () => {
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([
        {
          id: 'inv-credit',
          invoice_number: 'KR-F-1',
          status: 'sent',
          total: -1250,
          total_sek: -1250,
          vat_amount: -250,
          vat_amount_sek: -250,
          vat_treatment: 'standard_25',
          credited_invoice_id: 'inv-original',
          document_type: 'invoice',
          items: [{ sort_order: 0, line_total: -1000, vat_rate: 25, vat_amount: -250 }],
        },
      ])
      .mockResolvedValueOnce([])
      // The date-bounded journal query returns nothing. A current row pointer
      // must not erase the historical credit balance.
      .mockResolvedValueOnce([])
    vi.mocked(fetchPaymentTotalsByParent)
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(new Map())

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables.map((row) => row.id)).toEqual(['inv-credit'])
    const { receivableLines } = buildCutoffLines(result.receivables, [])
    expect(receivableLines.every((line) => line.debit_amount >= 0 && line.credit_amount >= 0)).toBe(true)
    expect(sum(receivableLines)).toEqual({ debit: 1250, credit: 1250 })
  })
})

describe('collectKontantmetodCutoff: supplier credits', () => {

  it.each([
    { label: 'positive magnitude', total: 1250, vat: 250, lineTotal: 1000 },
    { label: 'signed negative', total: -1250, vat: -250, lineTotal: -1000 },
  ])('nets a full unbooked $label credit with its original', async ({
    total,
    vat,
    lineTotal,
  }) => {
    mockSupplierCollection([
      supplierDocument({ status: 'credited' }),
      supplierDocument({
        id: 'si-credit',
        supplier_invoice_number: 'KREDIT-L-1',
        total,
        total_sek: total,
        vat_amount: vat,
        vat_amount_sek: vat,
        is_credit_note: true,
        credited_invoice_id: 'si-original',
        items: [{ sort_order: 0, account_number: '5410', line_total: lineTotal }],
      }),
    ])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.outstanding)).toEqual([1250, -1250])
    expect(buildCutoffLines([], result.payables).payableLines).toEqual([])
  })

  it('excludes a supplier credit represented by a live posted source voucher by cutoff', async () => {
    mockSupplierCollection([
      supplierDocument({ status: 'credited' }),
      supplierDocument({
        id: 'si-credit',
        total: 1250,
        total_sek: 1250,
        vat_amount: 250,
        vat_amount_sek: 250,
        is_credit_note: true,
        credited_invoice_id: 'si-original',
      }),
    ], ['si-credit'])
    const sourceQuery: Record<string, Mock> = {}
    for (const method of ['select', 'eq', 'in', 'lte', 'order', 'range']) {
      sourceQuery[method] = vi.fn(() => sourceQuery)
    }
    const supabase = { from: vi.fn(() => sourceQuery) }

    const result = await collectKontantmetodCutoff(
      supabase as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
    expect(buildCutoffLines([], result.payables).payableTotal).toBe(1250)

    const supplierSourceQuery = vi.mocked(fetchAllRows).mock.calls[2][0]
    supplierSourceQuery({ from: 0, to: 999 })
    expect(sourceQuery.in).toHaveBeenCalledWith('source_type', [
      'supplier_invoice_registered',
      'supplier_invoice_cash_payment',
      'supplier_invoice_privately_paid',
      'supplier_credit_note',
    ])
    const supplierQuery = vi.mocked(fetchAllRows).mock.calls[1][0]
    supplierQuery({ from: 0, to: 999 })
    expect(sourceQuery.in).toHaveBeenCalledWith('status', [
      'registered',
      'approved',
      'partially_paid',
      'paid',
      'overdue',
      'credited',
      'disputed',
      'reversed',
    ])
    expect(sourceQuery.in).toHaveBeenCalledWith('status', ['posted', 'reversed'])
    expect(sourceQuery.lte).not.toHaveBeenCalledWith('entry_date', '2025-12-31')
    expect(sourceQuery.order).toHaveBeenCalledWith('id', { ascending: true })
    const supplierPaymentQuery = vi.mocked(fetchAllRows).mock.calls[5][0]
    supplierPaymentQuery({ from: 0, to: 999 })
    expect(sourceQuery.in).toHaveBeenCalledWith('supplier_invoice_id', ['si-original'])
    expect(sourceQuery.in).not.toHaveBeenCalledWith('supplier_invoice_id', [
      'si-original',
      'si-credit',
    ])
  })

  it('rejects a posted December source root with visible storno and January correction children', async () => {
    const root = sourceJournalEntry('si-original', {
      status: 'posted',
      entry_date: '2025-12-15',
    })
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([]) // customer documents
      .mockResolvedValueOnce([supplierDocument()])
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([correctionEntry(root.id, '2026-01-15')])
      .mockResolvedValueOnce([stornoEntry(root.id, '2025-12-15')])

    await expect(collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )).rejects.toThrow(`Contradictory partial journal lineage for posted entry ${root.id}`)
  })

  it('keeps a currently reversed credit live when its uncredit lineage is after cutoff', async () => {
    const creditRoot = sourceJournalEntry('si-credit', {
      status: 'reversed',
      source_type: 'supplier_credit_note',
      entry_date: '2026-01-10',
    })
    mockSupplierLineage({
      supplierRows: [
        supplierDocument({ status: 'credited' }),
        supplierDocument({
          id: 'si-credit',
          supplier_invoice_number: 'KREDIT-L-1',
          status: 'reversed',
          reversed_at: '2026-01-15T10:00:00Z',
          is_credit_note: true,
          credited_invoice_id: 'si-original',
        }),
      ],
      sourceRoots: [creditRoot],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(creditRoot.id, '2026-01-15')],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.outstanding)).toEqual([1250, -1250])
    expect(buildCutoffLines([], result.payables).payableLines).toEqual([])
  })

  it('excludes a currently reversed credit when exact storno lineage is on cutoff', async () => {
    const creditRoot = sourceJournalEntry('si-credit', {
      status: 'reversed',
      source_type: 'supplier_credit_note',
    })
    mockSupplierLineage({
      supplierRows: [
        supplierDocument({ status: 'credited' }),
        supplierDocument({
          id: 'si-credit',
          status: 'reversed',
          reversed_at: '2026-01-15T10:00:00Z',
          is_credit_note: true,
          credited_invoice_id: 'si-original',
        }),
      ],
      sourceRoots: [creditRoot],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(creditRoot.id, '2025-12-31')],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
  })

  it('keeps a currently disputed supplier invoice as a cutoff liability', async () => {
    mockSupplierCollection([supplierDocument({ status: 'disputed' })])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
    expect(result.payables[0]?.outstanding).toBe(1250)
  })

  it('removes a document effect when its plain storno date is on cutoff', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, '2025-12-31')],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
  })

  it('keeps a document effect when its plain storno date is after cutoff', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, '2026-01-15')],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it('applies a default same-date reversal despite its later commit time', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, root.entry_date, {
          committed_at: '2026-01-20T10:00:00Z',
        })],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
  })

  it('removes the parent document effect before a future corrected child', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, '2026-01-15')],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
  })

  it('removes the parent customer document effect before a future corrected child', async () => {
    const root = sourceJournalEntry('inv-future-correction', {
      id: 'je-inv-future-correction',
      source_type: 'invoice_created',
      status: 'reversed',
    })
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([{
        id: 'inv-future-correction',
        invoice_number: 'F-FUTURE',
        total: 1250,
        total_sek: 1250,
        vat_amount: 250,
        vat_amount_sek: 250,
        vat_treatment: 'standard_25',
        credited_invoice_id: null,
        document_type: 'invoice',
        items: [{ sort_order: 0, line_total: 1000, vat_rate: 25, vat_amount: 250 }],
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([correctionEntry(root.id, '2026-01-15')])
      .mockResolvedValueOnce([stornoEntry(root.id, root.entry_date)])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables.map((row) => row.id)).toEqual([
      'inv-future-correction',
    ])
  })

  it('uses a corrected document child dated on cutoff', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, '2025-12-31')],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it('finds a future-dated supplier root corrected back into the cutoff period', async () => {
    const root = sourceJournalEntry('si-original', {
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, '2025-12-31')],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it('finds a future-dated customer root corrected back into the cutoff period', async () => {
    const root = sourceJournalEntry('inv-backdated', {
      id: 'je-inv-backdated',
      source_type: 'invoice_created',
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce([{
        id: 'inv-backdated',
        invoice_number: 'F-BACKDATED',
        total: 1250,
        total_sek: 1250,
        vat_amount: 250,
        vat_amount_sek: 250,
        vat_treatment: 'standard_25',
        credited_invoice_id: null,
        document_type: 'invoice',
        items: [{ sort_order: 0, line_total: 1000, vat_rate: 25, vat_amount: 250 }],
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([correctionEntry(root.id, '2025-12-31')])
      .mockResolvedValueOnce([stornoEntry(root.id, root.entry_date)])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.receivables).toEqual([])
  })

  it('traverses a future correction child that was itself corrected back into period', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    const futureCorrection = correctionEntry(root.id, '2026-01-15', {
      status: 'reversed',
    })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [
        {
          corrections: [futureCorrection],
          reversals: [stornoEntry(root.id, root.entry_date)],
        },
        {
          corrections: [correctionEntry(futureCorrection.id, '2025-12-31')],
          reversals: [stornoEntry(futureCorrection.id, futureCorrection.entry_date)],
        },
      ],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it('removes a corrected document child plainly reversed on cutoff', async () => {

    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    const corrected = correctionEntry(root.id, '2025-11-30', {
      status: 'reversed',
    })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [
        {
          corrections: [corrected],
          reversals: [stornoEntry(root.id, root.entry_date)],
        },
        {
          corrections: [],
          reversals: [stornoEntry(corrected.id, '2025-12-31')],
        },
      ],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original'])
  })

  it('keeps a corrected document child plainly reversed after cutoff', async () => {
    const root = sourceJournalEntry('si-original', { status: 'reversed' })
    const corrected = correctionEntry(root.id, '2025-11-30', {
      status: 'reversed',
    })
    mockSupplierLineage({
      sourceRoots: [root],
      lineageWaves: [
        {
          corrections: [corrected],
          reversals: [stornoEntry(root.id, root.entry_date)],
        },
        {
          corrections: [],
          reversals: [stornoEntry(corrected.id, '2026-01-15')],
        },
      ],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it('fails loudly for missing storno lineage', async () => {
    const missingStorno = sourceJournalEntry('si-original', {
      status: 'reversed',
    })
    mockSupplierLineage({ sourceRoots: [missingStorno] })

    await expect(collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )).rejects.toThrow(/storno lineage/)
  })

  it('accepts legacy posted source rows with nullable committed_at', async () => {
    const nullableCommit = sourceJournalEntry('si-original', {
      committed_at: null,
    })
    mockSupplierLineage({ sourceRoots: [nullableCommit] })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables).toEqual([])
  })

  it.each([
    { label: 'on cutoff', stornoDate: '2025-12-31', outstanding: 1250 },
    { label: 'after cutoff', stornoDate: '2026-01-15', outstanding: 750 },
    { label: 'on the original date', stornoDate: '2025-06-30', outstanding: 1250 },
  ])('uses the plain payment storno accounting date $label', async ({
    stornoDate,
    outstanding,
  }) => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-1',
        supplier_invoice_id: 'si-original',
        payment_date: '2025-06-30',
        amount: 500,
        journal_entry_id: root.id,
        reversed_at: '2026-01-15T10:00:00Z',
        reversed_by_journal_entry_id: 'storno-payment',
      }],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, stornoDate)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(outstanding)
  })

  it('aggregates an active duplicate linked allocation pair with öre rounding', async () => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-duplicate-payment',
      source_type: 'supplier_invoice_paid',
    })
    mockSupplierLineage({
      paymentRows: [
        {
          id: 'payment-1',
          supplier_invoice_id: 'si-original',
          payment_date: '2025-06-30',
          amount: 100.005,
          journal_entry_id: root.id,
        },
        {
          id: 'payment-duplicate',
          supplier_invoice_id: 'si-original',
          payment_date: '2025-06-30',
          amount: 100.005,
          journal_entry_id: root.id,
        },
      ],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(1049.98)
  })

  it('collapses a duplicate linked allocation pair before applying its reversal', async () => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-duplicate-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    mockSupplierLineage({
      paymentRows: [
        {
          id: 'payment-1',
          supplier_invoice_id: 'si-original',
          payment_date: '2025-06-30',
          amount: 100.005,
          journal_entry_id: root.id,
        },
        {
          id: 'payment-duplicate',
          supplier_invoice_id: 'si-original',
          payment_date: '2025-06-30',
          amount: 100.005,
          journal_entry_id: root.id,
        },
      ],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, '2025-12-31')],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(1250)
  })

  it('collapses a duplicate linked allocation pair before following its correction', async () => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-duplicate-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    mockSupplierLineage({
      paymentRows: [
        {
          id: 'payment-1',
          supplier_invoice_id: 'si-original',
          payment_date: '2026-01-15',
          amount: 100.005,
          journal_entry_id: root.id,
        },
        {
          id: 'payment-duplicate',
          supplier_invoice_id: 'si-original',
          payment_date: '2026-01-15',
          amount: 100.005,
          journal_entry_id: root.id,
        },
      ],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, '2025-12-15')],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(1049.98)
  })

  it.each([
    {
      label: 'on cutoff',
      stornoDate: '2025-12-31',
      outstandingById: { 'si-original': 1250, 'si-second': 500 },
    },
    {
      label: 'after cutoff',
      stornoDate: '2026-01-15',
      outstandingById: { 'si-original': 750, 'si-second': 300 },
    },
  ])('retains every shared batch allocation when storno is $label', async ({
    stornoDate,
    outstandingById,
  }) => {
    const root = sourceJournalEntry('', {
      id: 'je-batch-payment',
      source_id: null,
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    mockSupplierLineage({
      supplierRows: [
        supplierDocument(),
        supplierDocument({
          id: 'si-second',
          supplier_invoice_number: 'L-2',
          total: 500,
          total_sek: 500,
          vat_amount: 100,
          vat_amount_sek: 100,
          items: [{ sort_order: 0, account_number: '5410', line_total: 400 }],
        }),
      ],
      paymentRows: [
        {
          id: 'payment-1',
          supplier_invoice_id: 'si-original',
          payment_date: '2025-06-30',
          amount: 500,
          journal_entry_id: root.id,
          reversed_at: '2026-01-15T10:00:00Z',
          reversed_by_journal_entry_id: 'storno-batch',
        },
        {
          id: 'payment-2',
          supplier_invoice_id: 'si-second',
          payment_date: '2025-06-30',
          amount: 200,
          journal_entry_id: root.id,
          reversed_at: '2026-01-15T10:00:00Z',
          reversed_by_journal_entry_id: 'storno-batch',
        },
      ],
      linkedRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, stornoDate)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(Object.fromEntries(
      result.payables.map((row) => [row.id, row.outstanding]),
    )).toEqual(outstandingById)
  })

  it.each([
    {
      label: 'after cutoff',
      correctionDate: '2026-01-15',
      outstanding: 1250,
    },
    {
      label: 'on cutoff',
      correctionDate: '2025-12-31',
      outstanding: 750,
    },
  ])('uses a linked payment correction child dated $label', async ({
    correctionDate,
    outstanding,
  }) => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-1',
        supplier_invoice_id: 'si-original',
        payment_date: '2025-06-30',
        amount: 500,
        journal_entry_id: root.id,
        reversed_at: '2026-01-15T10:00:00Z',
        reversed_by_journal_entry_id: 'storno-payment',
      }],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, correctionDate)],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(outstanding)
  })

  it.each([
    {
      label: 'source-linked',
      sourceType: 'supplier_invoice_paid',
      sourceId: 'si-original',
      paymentVoucherRoot: true,
    },
    {
      label: 'manual',
      sourceType: 'manual',
      sourceId: null,
      paymentVoucherRoot: false,
    },
  ])('uses corrected journal lineage for a $label payment dated after cutoff', async ({
    sourceType,
    sourceId,
    paymentVoucherRoot,
  }) => {
    const root = sourceJournalEntry('', {
      id: 'je-payment-after-cutoff',
      source_id: sourceId,
      source_type: sourceType,
      status: 'reversed',
      entry_date: '2026-01-15',
    })
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-after-cutoff',
        supplier_invoice_id: 'si-original',
        payment_date: '2026-01-15',
        amount: 500,
        journal_entry_id: root.id,
      }],
      linkedRoots: [root],
      paymentVoucherRoots: paymentVoucherRoot ? [root] : [],
      lineageWaves: [{
        corrections: [correctionEntry(root.id, '2025-12-31')],
        reversals: [stornoEntry(root.id, root.entry_date)],
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(750)
  })

  it.each([
    { label: 'on cutoff', stornoDate: '2025-12-31', outstanding: 1250 },
    { label: 'after cutoff', stornoDate: '2026-01-15', outstanding: 750 },
  ])('handles a corrected payment child plainly reversed $label', async ({
    stornoDate,
    outstanding,
  }) => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    const corrected = correctionEntry(root.id, '2025-11-30', {
      status: 'reversed',
    })
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-1',
        supplier_invoice_id: 'si-original',
        payment_date: '2025-06-30',
        amount: 500,
        journal_entry_id: root.id,
        reversed_at: '2026-01-15T10:00:00Z',
        reversed_by_journal_entry_id: 'storno-payment',
      }],
      linkedRoots: [root],
      paymentVoucherRoots: [root],
      lineageWaves: [
        {
          corrections: [corrected],
          reversals: [stornoEntry(root.id, root.entry_date)],
        },
        {
          corrections: [],
          reversals: [stornoEntry(corrected.id, stornoDate)],
        },
      ],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(outstanding)
  })

  it('fails loudly when reversal cleanup deleted a live payment amount', async () => {
    const root = sourceJournalEntry('si-original', {
      id: 'je-payment',
      source_type: 'supplier_invoice_paid',
      status: 'reversed',
    })
    mockSupplierLineage({
      paymentVoucherRoots: [root],
      lineageWaves: [{
        corrections: [],
        reversals: [stornoEntry(root.id, '2026-01-15')],
      }],
    })

    await expect(collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )).rejects.toThrow(/Missing supplier payment history/)
  })

  it('keeps legitimate legacy payments with no journal link', async () => {
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-legacy',
        supplier_invoice_id: 'si-original',
        payment_date: '2025-06-30',
        amount: 500,
        journal_entry_id: null,
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(750)
  })

  it('excludes a future legacy payment with no journal lineage', async () => {
    mockSupplierLineage({
      paymentRows: [{
        id: 'payment-legacy-future',
        supplier_invoice_id: 'si-original',
        payment_date: '2026-01-15',
        amount: 500,
        journal_entry_id: null,
      }],
    })

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables[0]?.outstanding).toBe(1250)
  })

  it('keeps a supplier credit historically visible when its source voucher is later', async () => {
    mockSupplierCollection([
      supplierDocument({ status: 'credited' }),
      supplierDocument({
        id: 'si-credit',
        total: 1250,
        total_sek: 1250,
        vat_amount: 250,
        vat_amount_sek: 250,
        is_credit_note: true,
        credited_invoice_id: 'si-original',
        registration_journal_entry_id: 'posted-after-cutoff',
      }),
    ])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )

    expect(result.payables.map((row) => row.id)).toEqual(['si-original', 'si-credit'])
    expect(buildCutoffLines([], result.payables).payableLines).toEqual([])
  })

  it('emits a net supplier credit as positive amounts on opposite accounting sides', async () => {
    mockSupplierCollection([
      supplierDocument({
        id: 'si-credit',
        total: 625,
        total_sek: 625,
        vat_amount: 125,
        vat_amount_sek: 125,
        is_credit_note: true,
        credited_invoice_id: 'missing-original',
        items: [{ sort_order: 0, account_number: '5410', line_total: 500 }],
      }),
    ])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )
    const { payableLines } = buildCutoffLines([], result.payables)

    expect(payableLines).toEqual([
      expect.objectContaining({
        account_number: '5410',
        debit_amount: 0,
        credit_amount: 500,
      }),
      expect.objectContaining({
        account_number: '2648',
        debit_amount: 0,
        credit_amount: 125,
      }),
      expect.objectContaining({
        account_number: '2440',
        debit_amount: 625,
        credit_amount: 0,
      }),
    ])
    expect(payableLines.every((line) =>
      line.debit_amount >= 0 && line.credit_amount >= 0,
    )).toBe(true)
    expect(sum(payableLines)).toEqual({ debit: 625, credit: 625 })
  })

  it('preserves supplier expense accounts, input VAT, and whole-ore balance while netting', async () => {
    mockSupplierCollection([
      supplierDocument({
        status: 'credited',
        total: 1875,
        total_sek: 1875,
        vat_amount: 375,
        vat_amount_sek: 375,
        items: [
          { sort_order: 0, account_number: '5410', line_total: 1000 },
          { sort_order: 1, account_number: '6540', line_total: 500 },
        ],
      }),
      supplierDocument({
        id: 'si-credit',
        total: 625,
        total_sek: 625,
        vat_amount: 125,
        vat_amount_sek: 125,
        is_credit_note: true,
        credited_invoice_id: 'si-original',
        items: [
          { sort_order: 0, account_number: null, line_total: 400 },
          { sort_order: 1, account_number: null, line_total: 100 },
        ],
      }),
    ])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )
    const { payableLines, payableTotal } = buildCutoffLines([], result.payables)

    expect(payableTotal).toBe(1250)
    expect(payableLines.find((line) => line.account_number === '5410')?.debit_amount).toBe(600)
    expect(payableLines.find((line) => line.account_number === '6540')?.debit_amount).toBe(400)
    expect(payableLines.find((line) => line.account_number === '2648')?.debit_amount).toBe(250)
    expect(payableLines.find((line) => line.account_number === '2440')?.credit_amount).toBe(1250)
    expect(sum(payableLines)).toEqual({ debit: 1250, credit: 1250 })
  })

  it('keeps reverse-charge supplier credit VAT out of the dormant VAT account', async () => {
    mockSupplierCollection([
      supplierDocument({
        id: 'si-credit',
        total: -400,
        total_sek: -400,
        vat_amount: -100,
        vat_amount_sek: -100,
        reverse_charge: true,
        is_credit_note: true,
        items: [{ sort_order: 0, account_number: '4535', line_total: -400 }],
      }),
    ])

    const result = await collectKontantmetodCutoff(
      {} as never,
      'co-1',
      '2025-01-01',
      '2025-12-31',
    )
    const { payableLines } = buildCutoffLines([], result.payables)

    expect(payableLines.some((line) => line.account_number === '2648')).toBe(false)
    expect(payableLines.every((line) =>
      line.debit_amount >= 0 && line.credit_amount >= 0,
    )).toBe(true)
    expect(sum(payableLines)).toEqual({ debit: 400, credit: 400 })
  })
})

describe('distributeOre', () => {
  it('splits exactly, with no öre lost or invented', () => {
    // 100 öre over three equal buckets cannot divide evenly: the largest
    // remainders must absorb the leftovers rather than the total drifting.
    const parts = distributeOre(100, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(parts).toEqual([34, 33, 33])
  })

  it('weights proportionally', () => {
    expect(distributeOre(1000, [3, 1])).toEqual([750, 250])
  })

  it('handles degenerate input without emitting NaN', () => {
    expect(distributeOre(500, [0, 0])).toEqual([500, 0])
    expect(distributeOre(500, [])).toEqual([])
    expect(distributeOre(500, [7])).toEqual([500])
  })
})

describe('buildCutoffLines: fordringar', () => {
  it('books the receivable against revenue and VILANDE output moms', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])

    const debit = receivableLines.find((l) => l.debit_amount > 0)
    expect(debit?.account_number).toBe('1510')
    expect(debit?.debit_amount).toBe(1250)

    // The final-period cut-off uses 2618, not the ordinary 2611 account. The
    // declaration map still reports it in ruta 10 for the accounting year.
    const vatLine = receivableLines.find((l) => l.account_number === '2618')
    expect(vatLine?.credit_amount).toBe(250)
    expect(receivableLines.some((l) => l.account_number === '2611')).toBe(false)

    expect(receivableLines.find((l) => l.account_number === '3001')?.credit_amount).toBe(1000)
  })

  it('balances', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', outstanding: 1250, vat: 250 }),
        receivable({ id: 'b', outstanding: 560, vat: 60, vatTreatment: 'reduced_12' }),
        receivable({ id: 'c', outstanding: 106, vat: 6, vatTreatment: 'reduced_6' }),
      ],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.debit).toBe(1916)
  })

  it('balances on amounts that do not divide evenly', () => {
    // 33.33 % style residue: net is derived as outstanding - vat precisely so
    // the two legs always add back to the receivable.
    const { receivableLines } = buildCutoffLines(
      [receivable({ outstanding: 1000.01, vat: 200.003 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('uses one vilande account per rate', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', vatTreatment: 'standard_25' }),
        receivable({ id: 'b', outstanding: 1120, vat: 120, vatTreatment: 'reduced_12' }),
      ],
      [],
    )
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.standard_25)).toBeDefined()
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.reduced_12)).toBeDefined()
  })

  it('treats a zero-moms treatment as pure revenue', () => {
    // Export carries no Swedish output moms, so nothing may land on a vilande
    // account: the full outstanding is revenue.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 0 })],
      [],
    )
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expect(receivableLines.find((l) => l.account_number === '3305')?.credit_amount).toBe(5000)
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still balances if a stray moms amount reaches buildCutoffLines directly', () => {
    // The collector now excludes these rows and the posting step refuses them,
    // so this is the last-resort path. It must never invent a moms account and
    // must never unbalance the verifikat.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 100 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  })

  it('emits nothing when there is nothing outstanding', () => {
    expect(buildCutoffLines([], []).receivableLines).toEqual([])
    expect(buildCutoffLines([receivable({ outstanding: 0, vat: 0 })], []).receivableLines).toEqual([])
  })

  it('normalizes a net credit position to positive opposite-side lines', () => {
    const { receivableLines } = buildCutoffLines([
      receivable({ outstanding: -1250, vat: -250 }),
    ], [])

    expect(receivableLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_number: '1510', debit_amount: 0, credit_amount: 1250 }),
      expect.objectContaining({ account_number: '3001', debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2618', debit_amount: 250, credit_amount: 0 }),
    ]))
    expect(receivableLines.every((line) => line.debit_amount >= 0 && line.credit_amount >= 0)).toBe(true)
    expect(sum(receivableLines)).toEqual({ debit: 1250, credit: 1250 })
  })
})

describe('buildCutoffLines: skulder', () => {
  it('books the payable against expense and VILANDE input moms', () => {
    const { payableLines } = buildCutoffLines([], [payable()])

    const credit = payableLines.find((l) => l.credit_amount > 0)
    expect(credit?.account_number).toBe('2440')
    expect(credit?.credit_amount).toBe(1250)

    // 2648, not 2641: the final-period cut-off enters ruta 48 once.
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
    expect(payableLines.some((l) => l.account_number === '2641')).toBe(false)

    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(1000)
  })

  it('reports deferred input VAT once across cutoff, reversal, and cash payment', async () => {
    const toTotals = (
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
    ) => {
      const totals = new Map<string, { debit: number; credit: number }>()
      for (const line of lines) {
        const current = totals.get(line.account_number) ?? { debit: 0, credit: 0 }
        current.debit = roundOre(current.debit + line.debit_amount)
        current.credit = roundOre(current.credit + line.credit_amount)
        totals.set(line.account_number, current)
      }
      return totals
    }

    const { payableLines: cutoffLines } = buildCutoffLines([], [payable()])
    const reversalLines = reverseLines(cutoffLines)
    const invoice = makeSupplierInvoice({
      id: 'si-1',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
    })
    vi.mocked(createJournalEntry).mockReset().mockResolvedValue({ id: 'je-payment' } as never)
    await createSupplierInvoiceCashEntry(
      null as never,
      'co-1',
      'user-1',
      invoice,
      [{
        id: 'si-item-1',
        supplier_invoice_id: invoice.id,
        sort_order: 0,
        description: 'Kontorsmaterial',
        quantity: 1,
        unit: 'st',
        unit_price: 1000,
        line_total: 1000,
        account_number: '5410',
        vat_code: null,
        vat_rate: 0.25,
        vat_amount: 250,
        reverse_charge_rate: null,
        created_at: '2025-12-15T00:00:00Z',
      }],
      '2026-01-15',
      'swedish_business',
    )
    const paymentLines = vi.mocked(createJournalEntry).mock.calls[0][3].lines
    const controlled2648Contribution = (
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
    ) => roundOre(lines
      .filter((line) => line.account_number === VILANDE_INPUT_VAT_ACCOUNT)
      .reduce((sum, line) => sum + line.debit_amount - line.credit_amount, 0))
    const decemberContribution = controlled2648Contribution(cutoffLines)
    const januaryReversalContribution = controlled2648Contribution(reversalLines)
    const laterPaymentContribution = rutorFromTotals(toTotals(paymentLines)).ruta48

    expect(cutoffLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        account_number: '2648',
        debit_amount: 250,
        credit_amount: 0,
      }),
    ]))
    expect(reversalLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        account_number: '2648',
        debit_amount: 0,
        credit_amount: 250,
      }),
    ]))
    expect(paymentLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        account_number: '2641',
        debit_amount: 250,
        credit_amount: 0,
      }),
      expect.objectContaining({
        account_number: '1930',
        debit_amount: 0,
        credit_amount: 1250,
      }),
    ]))
    expect(paymentLines.some((line) => line.account_number === '2440')).toBe(false)
    expect(decemberContribution).toBe(250)
    expect(januaryReversalContribution).toBe(-250)
    expect(laterPaymentContribution).toBe(250)
    expect(roundOre(januaryReversalContribution + laterPaymentContribution)).toBe(0)
  })

  it('splits the net across several expense accounts and still balances', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 1250,
          vat: 250,
          netByAccount: [
            { account: '5410', amount: 700 },
            { account: '6110', amount: 300 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(700)
    expect(payableLines.find((l) => l.account_number === '6110')?.debit_amount).toBe(300)
  })

  it('balances when the account split cannot divide evenly', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 100.01,
          vat: 0,
          netByAccount: [
            { account: '5410', amount: 1 },
            { account: '6110', amount: 1 },
            { account: '6210', amount: 1 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.credit).toBe(100.01)
  })

  it('falls back to a generic expense account when item detail is missing', () => {
    const { payableLines } = buildCutoffLines([], [payable({ netByAccount: [] })])
    expect(payableLines.find((l) => l.account_number === '6990')?.debit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })
  it('emits expense reclassification when equal gross amounts use different accounts', () => {
    const { payableLines, payableTotal } = buildCutoffLines([], [
      payable(),
      payable({
        id: 'si-credit',
        outstanding: -1250,
        vat: -250,
        netByAccount: [{ account: '6540', amount: 1000 }],
      }),
    ])

    expect(payableTotal).toBe(0)
    expect(payableLines).toEqual([
      expect.objectContaining({
        account_number: '5410',
        debit_amount: 1000,
        credit_amount: 0,
      }),
      expect.objectContaining({
        account_number: '6540',
        debit_amount: 0,
        credit_amount: 1000,
      }),
    ])
    expect(payableLines.some((line) => line.account_number === '2440')).toBe(false)
    expect(sum(payableLines)).toEqual({ debit: 1000, credit: 1000 })
  })

  it('emits VAT composition reclassification when equal gross amounts split differently', () => {
    const { payableLines, payableTotal } = buildCutoffLines([], [
      payable(),
      payable({
        id: 'si-credit',
        outstanding: -1250,
        vat: -150,
        netByAccount: [{ account: '5410', amount: 1100 }],
      }),
    ])

    expect(payableTotal).toBe(0)
    expect(payableLines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        account_number: '5410',
        debit_amount: 0,
        credit_amount: 100,
      }),
      expect.objectContaining({
        account_number: VILANDE_INPUT_VAT_ACCOUNT,
        debit_amount: 100,
        credit_amount: 0,
      }),
    ]))
    expect(payableLines.some((line) => line.account_number === '2440')).toBe(false)
    expect(payableLines.every((line) =>
      line.debit_amount >= 0 && line.credit_amount >= 0
    )).toBe(true)
    expect(sum(payableLines)).toEqual({ debit: 100, credit: 100 })
  })

})

describe('reverseLines', () => {
  it('swaps every debit and credit so the vändning nets to zero', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])
    const reversed = reverseLines(receivableLines)

    const original = sum(receivableLines)
    const back = sum(reversed)
    expect(back.debit).toBe(original.credit)
    expect(back.credit).toBe(original.debit)

    // Net effect of cut-off + vändning on 1510 is exactly zero.
    const net = [...receivableLines, ...reversed]
      .filter((l) => l.account_number === '1510')
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
    expect(net).toBe(0)
  })

  it('labels the reversal so the verifikat is self-explanatory', () => {
    expect(reverseLines([{ account_number: '1510', debit_amount: 10, credit_amount: 0, line_description: 'X' }])[0]
      .line_description).toBe('Vändning: X')
  })
})

describe('nextDay', () => {
  it('rolls over year end', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  it('handles a broken fiscal year and a leap day', () => {
    expect(nextDay('2026-06-30')).toBe('2026-07-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })
})

describe('buildCutoffNote (BFL 5 kap 6-7 §: traceability)', () => {
  it('names the invoices an aggregate verifikat covers', () => {
    expect(buildCutoffNote('Kundfordringar', ['F-1', 'F-2'])).toBe(
      'Kundfordringar (2 st): F-1, F-2',
    )
  })

  it('truncates a long list to a pointer rather than an unbounded note', () => {
    const refs = Array.from({ length: 60 }, (_, i) => `F-${i + 1}`)
    const note = buildCutoffNote('Kundfordringar', refs)
    expect(note).toContain('(60 st)')
    expect(note).toContain('och 10 till')
  })

  it('is explicit when no invoice numbers exist', () => {
    expect(buildCutoffNote('Skulder', ['', '  '])).toBe('Skulder: inga fakturanummer registrerade')
  })
})

describe('postKontantmetodCutoff', () => {
  const OPEN_NEXT = {
    id: 'fp-next',
    period_start: '2027-01-01',
    period_end: '2027-12-31',
    is_closed: false,
    locked_at: null,
  }

  const makeSupabase = (next: Record<string, unknown> | null) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: next, error: next ? null : { message: 'x' } }) }),
        }),
      }),
    }),
  }) as never

  const baseOpts = {
    fiscalPeriodId: 'fp-1',
    nextFiscalPeriodId: 'fp-next',
    periodEnd: '2026-12-31',
    receivables: [receivable()],
    payables: [],
  }

  beforeEach(() => {
    vi.mocked(createJournalEntry).mockReset()
    vi.mocked(reverseEntry).mockReset()
  })

  it('posts the cut-off and its vändning, carrying invoice refs into notes', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockResolvedValueOnce({ id: 'je-reversal' } as never)

    const result = await postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts)

    expect(result.receivableEntry?.id).toBe('je-cutoff')
    expect(result.receivableReversal?.id).toBe('je-reversal')

    const cutoffCall = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(cutoffCall.entry_date).toBe('2026-12-31')
    expect(cutoffCall.notes).toContain('F-1')
    const reversalCall = vi.mocked(createJournalEntry).mock.calls[1][3]
    expect(reversalCall.entry_date).toBe('2027-01-01')
    expect(reversalCall.fiscal_period_id).toBe('fp-next')
  })

  it('refuses before posting anything when the next period does not exist', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase(null), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/nästa räkenskapsår/i)
    // The critical assertion: nothing was posted, so no un-reversed cut-off.
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses before posting anything when the next period is closed or locked', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase({ ...OPEN_NEXT, is_closed: true }), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/stängt eller låst/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()

    await expect(
      postKontantmetodCutoff(makeSupabase({ ...OPEN_NEXT, locked_at: '2027-02-01' }), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow(/stängt eller låst/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when the vändning date falls outside the next period', async () => {
    await expect(
      postKontantmetodCutoff(
        makeSupabase({ ...OPEN_NEXT, period_start: '2027-03-01' }),
        'co-1', 'user-1', baseOpts,
      ),
    ).rejects.toThrow(/utanför nästa räkenskapsår/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when an invoice carries moms on a momsfri treatment', async () => {
    // Absorbing it into revenue would balance the verifikat and swallow a real
    // invoicing error: the netting the swedish-vat reference prohibits.
    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
        ...baseOpts,
        strayVatOnZeroRate: ['F-7'],
      }),
    ).rejects.toThrow(/momsfri momsinställning/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('refuses when any invoice lacks a vat_treatment', async () => {
    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
        ...baseOpts,
        unknownVatTreatment: ['F-9'],
      }),
    ).rejects.toThrow(/saknar momsinställning/i)
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })

  it('stornoes the cut-off when its vändning fails, leaving no inflated 1510', async () => {
    // The failure mode the module exists to prevent: a committed cut-off with
    // no vändning inflates 1510/2440 permanently and double-books every
    // new-year payment.
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    vi.mocked(reverseEntry).mockResolvedValue({ id: 'je-storno' } as never)

    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow('period locked')

    expect(vi.mocked(reverseEntry)).toHaveBeenCalledWith(
      expect.anything(), 'co-1', 'user-1', 'je-cutoff', '2026-12-31',
    )
  })

  it('still rethrows the original error when the compensating storno also fails', async () => {
    vi.mocked(createJournalEntry)
      .mockResolvedValueOnce({ id: 'je-cutoff' } as never)
      .mockRejectedValueOnce(new Error('period locked'))
    vi.mocked(reverseEntry).mockRejectedValue(new Error('storno failed'))

    await expect(
      postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', baseOpts),
    ).rejects.toThrow('period locked')
  })

  it('posts nothing at all when there is nothing outstanding', async () => {
    const result = await postKontantmetodCutoff(makeSupabase(OPEN_NEXT), 'co-1', 'user-1', {
      ...baseOpts,
      receivables: [],
      payables: [],
    })
    expect(result.receivableEntry).toBeNull()
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })
})

describe('buildCutoffLines: omvänd betalningsskyldighet', () => {
  it('never routes reverse-charge moms into the single vilande bucket', () => {
    // A one-sided reverse charge is prohibited: the self-assessed output/input
    // pair belongs to the payment entry, not to a deferred 2648 balance.
    const { payableLines } = buildCutoffLines(
      [],
      [payable({ outstanding: 1000, vat: 250, reverseCharge: true, netByAccount: [{ account: '4056', amount: 1000 }] })],
    )
    expect(payableLines.some((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)).toBe(false)
    // The full outstanding is expense against 2440.
    expect(payableLines.find((l) => l.account_number === '4056')?.debit_amount).toBe(1000)
    expect(payableLines.find((l) => l.account_number === '2440')?.credit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still books vilande moms for ordinary (non-RC) supplier invoices', () => {
    const { payableLines } = buildCutoffLines([], [payable({ reverseCharge: false })])
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
  })
})
