import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VatDeclarationRutor } from '@/types'

const mockCalculateVatDeclaration = vi.fn()
vi.mock('@/lib/reports/vat-declaration', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    calculateVatDeclaration: (...args: unknown[]) =>
      mockCalculateVatDeclaration(...args),
  }
})

import { computeVatReport } from '../server'

function makeRutor(partial: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor {
  return {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
    ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0, ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    ...partial,
  }
}

const MONTHLY_PERIOD = {
  type: 'monthly',
  year: 2026,
  period: 1,
  start: '2026-01-15',
  end: '2026-01-31',
  originalStart: '2026-01-01',
  originalEnd: '2026-01-31',
  fiscalPeriodId: null,
  fiscalPeriodStart: null,
  fiscalPeriodEnd: null,
  vatLiabilityStartDate: '2026-01-15',
} as const

function setDeclaration(
  rutor: VatDeclarationRutor,
  rcInputAccountTotals: Record<string, { debit: number; credit: number }> = {
    '2645': { debit: 0, credit: 0 },
    '2647': { debit: 0, credit: 0 },
  },
): void {
  mockCalculateVatDeclaration.mockResolvedValue({
    period: MONTHLY_PERIOD,
    rutor,
    rcInputAccountTotals,
    rcBasisByRate: { r25: 0, r12: 0, r6: 0 },
  })
}

const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  setDeclaration(makeRutor())
})

describe('computeVatReport', () => {
  it('projects one canonical core declaration without a second VAT snapshot', async () => {
    const rutor = makeRutor({
      ruta05: -1000,
      ruta10: -250,
      ruta48: 100,
      ruta49: 150,
    })
    setDeclaration(rutor)

    const report = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(mockCalculateVatDeclaration).toHaveBeenCalledTimes(1)
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'monthly',
      2026,
      1,
      undefined,
    )
    expect(report.rutor).toMatchObject({
      ruta05: 1000,
      ruta10: 250,
      ruta48: 100,
      ruta49: 150,
    })
    expect(report.summary).toBe('Moms att betala: 150 kr')
  })

  it('propagates liability clipping and original statutory bounds', async () => {
    const report = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(report.period).toEqual({
      type: 'monthly',
      year: 2026,
      period: 1,
      start: '2026-01-15',
      end: '2026-01-31',
      original_period_start: '2026-01-01',
      original_period_end: '2026-01-31',
      fiscal_period_id: null,
      fiscal_period_start: null,
      fiscal_period_end: null,
      vat_liability_start_date: '2026-01-15',
    })
  })

  it('warns when reverse-charge output has no canonical 2645 or 2647 input', async () => {
    setDeclaration(makeRutor({ ruta30: 250, ruta49: 250 }))

    const report = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatch(/2645 EU.*2647 inhemsk/)
  })

  it('does not warn when canonical 2647 input backs reverse-charge output', async () => {
    setDeclaration(
      makeRutor({ ruta30: 250, ruta48: 250, ruta49: 0 }),
      {
        '2645': { debit: 0, credit: 0 },
        '2647': { debit: 250, credit: 0 },
      },
    )

    const report = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(report.warnings).toEqual([])
  })

  it('propagates the exact annual fiscal-period identity', async () => {
    const fiscalPeriodId = '33333333-3333-4333-8333-333333333333'
    mockCalculateVatDeclaration.mockResolvedValue({
      period: {
        type: 'yearly',
        year: 2026,
        period: 1,
        start: '2025-07-01',
        end: '2026-06-30',
        originalStart: '2025-07-01',
        originalEnd: '2026-06-30',
        fiscalPeriodId,
        fiscalPeriodStart: '2025-07-01',
        fiscalPeriodEnd: '2026-06-30',
        vatLiabilityStartDate: null,
      },
      rutor: makeRutor(),
      rcInputAccountTotals: {},
      rcBasisByRate: { r25: 0, r12: 0, r6: 0 },
    })

    const report = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: fiscalPeriodId },
      'company-1',
      supabase,
    )

    expect(report.period).toMatchObject({
      fiscal_period_id: fiscalPeriodId,
      fiscal_period_start: '2025-07-01',
      fiscal_period_end: '2026-06-30',
      original_period_start: '2025-07-01',
      original_period_end: '2026-06-30',
    })
  })

  it('rejects an annual fiscal-period identity drift', async () => {
    const requestedId = '33333333-3333-4333-8333-333333333333'
    mockCalculateVatDeclaration.mockResolvedValue({
      period: {
        ...MONTHLY_PERIOD,
        type: 'yearly',
        year: 2026,
        period: 1,
        start: '2025-07-01',
        end: '2026-06-30',
        originalStart: '2025-07-01',
        originalEnd: '2026-06-30',
        fiscalPeriodId: '44444444-4444-4444-8444-444444444444',
        fiscalPeriodStart: '2025-07-01',
        fiscalPeriodEnd: '2026-06-30',
        vatLiabilityStartDate: null,
      },
      rutor: makeRutor(),
    })

    await expect(computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1, fiscal_period_id: requestedId },
      'company-1',
      supabase,
    )).rejects.toThrow(/fiscal period identity mismatch/i)
  })

  it('requires a fiscal-period ID for yearly requests', async () => {
    await expect(computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )).rejects.toThrow(/fiscal_period_id is required/)
    expect(mockCalculateVatDeclaration).not.toHaveBeenCalled()
  })

  it('rejects invalid period types, ranges, and years before projection', async () => {
    await expect(computeVatReport(
      { period_type: 'weekly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )).rejects.toThrow(/period_type/)
    await expect(computeVatReport(
      { period_type: 'monthly', year: 2026, period: 13 },
      'company-1',
      supabase,
    )).rejects.toThrow(/1-12/)
    await expect(computeVatReport(
      { period_type: 'monthly', year: 1900, period: 1 },
      'company-1',
      supabase,
    )).rejects.toThrow(/year must be between/)
  })
})
