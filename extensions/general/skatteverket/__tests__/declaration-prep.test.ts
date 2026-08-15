/**
 * Tests for the shared declaration-prep functions. These are the single
 * source of truth for what gets filed to Skatteverket: the HTTP route
 * handlers and the commit-side services both go through them, so a regression
 * here would mean different numbers filed than the user reviewed (no-drift
 * compliance guarantee).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { VatDeclarationRutor } from '@/types'

const mockCalculateVatDeclaration = vi.fn()
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...args: unknown[]) => mockCalculateVatDeclaration(...args),
}))
const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mockFindRcBasisGaps(...args),
}))

import { buildMomsuppgift, buildAgiUnderlag, resolveRedovisare } from '../lib/declaration-prep'
import { rutorToMomsuppgift } from '../lib/mappers'

const READ_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32',
  'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40', 'ruta41', 'ruta42',
  'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61', 'ruta62',
]

function zeroRutor(): VatDeclarationRutor {
  return Object.fromEntries(READ_KEYS.map((k) => [k, 0])) as unknown as VatDeclarationRutor
}

function declaration(rutor: VatDeclarationRutor, input: {
  type: 'monthly' | 'quarterly' | 'yearly'
  year: number
  period: number
  start: string
  end: string
  fiscalPeriodId?: string
}) {
  return {
    rutor,
    period: {
      type: input.type,
      year: input.year,
      period: input.period,
      start: input.start,
      end: input.end,
      originalStart: input.start,
      originalEnd: input.end,
      fiscalPeriodId: input.fiscalPeriodId ?? null,
      fiscalPeriodStart: input.fiscalPeriodId ? input.start : null,
      fiscalPeriodEnd: input.fiscalPeriodId ? input.end : null,
      vatLiabilityStartDate: null,
    },
    rcInputAccountTotals: {
      '2645': { debit: 0, credit: 0 },
      '2647': { debit: 0, credit: 0 },
    },
    rcBasisByRate: { r25: 0, r12: 0, r6: 0 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindRcBasisGaps.mockResolvedValue([])
})

describe('resolveRedovisare', () => {
  it('formats an aktiebolag org number to the 12-digit redovisare', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })
    const redovisare = await resolveRedovisare(supabase as never, 'company-1')
    expect(redovisare).toBe('165560000000')
  })

  it('throws when org number is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: null, entity_type: 'aktiebolag' } })
    await expect(resolveRedovisare(supabase as never, 'company-1')).rejects.toThrow(/Organisationsnummer saknas/)
  })
})

describe('buildMomsuppgift', () => {
  it('produces the same momsuppgift the route handler would (rutorToMomsuppgift over the GL rutor)', async () => {
    const rutor = zeroRutor()
    rutor.ruta10 = 250 // output VAT 25%
    rutor.ruta05 = 1000
    rutor.ruta48 = 100 // input VAT
    rutor.ruta49 = 150
    mockCalculateVatDeclaration.mockResolvedValue(declaration(rutor, {
      type: 'monthly',
      year: 2025,
      period: 3,
      start: '2025-03-01',
      end: '2025-03-31',
    }))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'monthly',
      year: 2025,
      period: 3,
      approvedRutor: rutor,
    })

    expect(result.redovisare).toBe('165560000000')
    expect(result.redovisningsperiod).toBe('202503')
    // Identical to the direct mapper output: locks the no-drift guarantee.
    expect(result.momsuppgift).toEqual(rutorToMomsuppgift(rutor))
    expect(result.momsuppgift.momsForsaljningUtgaendeHog).toBe(250)
    expect(result.momsuppgift.ingaendeMomsAvdrag).toBe(100)
    expect(result.momsuppgift.summaMoms).toBe(150)
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'monthly', 2025, 3, { fiscalPeriodId: undefined },
    )
  })

  it('targets the FY-end month for a broken-FY yearly filer (SFL 26 kap 10-11 §§)', async () => {
    const rutor = zeroRutor()
    mockCalculateVatDeclaration.mockResolvedValue(declaration(rutor, {
      type: 'yearly',
      year: 2026,
      period: 1,
      start: '2025-07-01',
      end: '2026-06-30',
      fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
    }))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
      approvedRutor: rutor,
    })

    expect(result.redovisningsperiod).toBe('202606')
    // The figures must describe the same räkenskapsår as the period id.
    expect(mockCalculateVatDeclaration).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'yearly', 2026, 1,
      { fiscalPeriodId: '11111111-1111-4111-8111-111111111111' },
    )
  })

  it('uses the actual calendar fiscal period identity without a fallback', async () => {
    const rutor = zeroRutor()
    mockCalculateVatDeclaration.mockResolvedValue(declaration(rutor, {
      type: 'yearly',
      year: 2025,
      period: 1,
      start: '2025-01-01',
      end: '2025-12-31',
      fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
    }))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })

    const result = await buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'yearly',
      year: 2025,
      period: 1,
      fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
      approvedRutor: rutor,
    })

    expect(result.redovisningsperiod).toBe('202512')
  })

  it('allows an unavailable reverse-charge scan when the period has no activity', async () => {
    const rutor = zeroRutor()
    mockCalculateVatDeclaration.mockResolvedValue(declaration(rutor, {
      type: 'monthly',
      year: 2026,
      period: 6,
      start: '2026-06-01',
      end: '2026-06-30',
    }))
    mockFindRcBasisGaps.mockRejectedValueOnce(new Error('read failed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })

    await expect(buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'monthly',
      year: 2026,
      period: 6,
      approvedRutor: rutor,
    })).resolves.toMatchObject({ redovisningsperiod: '202606' })
  })

  it('blocks when required reverse-charge scan evidence is unavailable', async () => {
    const rutor = zeroRutor()
    rutor.ruta30 = 250
    const value = declaration(rutor, {
      type: 'monthly',
      year: 2026,
      period: 6,
      start: '2026-06-01',
      end: '2026-06-30',
    })
    value.rcInputAccountTotals['2645'].debit = 250
    mockCalculateVatDeclaration.mockResolvedValue(value)
    mockFindRcBasisGaps.mockRejectedValueOnce(new Error('read failed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })

    await expect(buildMomsuppgift(supabase as never, 'company-1', {
      periodType: 'monthly',
      year: 2026,
      period: 6,
      approvedRutor: rutor,
    })).rejects.toThrow(/RC_BASIS_MISSING/)
  })
})

describe('buildAgiUnderlag', () => {
  it('loads the latest XML and formats arbetsgivare + period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'booked' } }) // salary_runs status guard
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } }) // resolveRedovisare
    enqueue({ data: { xml_content: '<agi/>', period_year: 2026, period_month: 3 } }) // agi_declarations

    const result = await buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')

    expect(result).toMatchObject({
      arbetsgivare: '165560000000',
      period: '202603',
      salaryRunId: 'sr-1',
      xml: '<agi/>',
      periodYear: 2026,
      periodMonth: 3,
    })
  })

  it('throws when the salary run is not past draft', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'draft' } })
    await expect(buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')).rejects.toThrow(/efter granskning/)
  })

  it('throws when salaryRunId is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(buildAgiUnderlag(supabase as never, 'company-1', '')).rejects.toThrow(/salaryRunId/)
  })

  it('throws when no AGI XML exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'booked' } })
    enqueue({ data: { org_number: '5560000000', entity_type: 'aktiebolag' } })
    enqueue({ data: { xml_content: null, period_year: 2026, period_month: 3 } })
    await expect(buildAgiUnderlag(supabase as never, 'company-1', 'sr-1')).rejects.toThrow(/AGI-XML saknas/)
  })
})
