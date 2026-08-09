import { describe, expect, it } from 'vitest'
import {
  buildVatReportRequest,
  selectVatFiscalPeriod,
} from '../vat-report-request'

describe('VAT dashboard report request period', () => {
  it('uses the initial selected fiscal period end year for annual requests', () => {
    const selection = selectVatFiscalPeriod('company-1', 'fp-2025', {
      id: 'fp-2025',
      company_id: 'company-1',
      period_end: '2025-12-31',
    })

    expect(buildVatReportRequest('yearly', 2026, 1, selection)).toEqual({
      periodType: 'yearly',
      year: 2025,
      period: 1,
      fiscalPeriodId: 'fp-2025',
    })
  })

  it('changes the annual request year when a different fiscal period is selected', () => {
    const initial = selectVatFiscalPeriod('company-1', 'fp-current', {
      id: 'fp-current',
      company_id: 'company-1',
      period_end: '2026-12-31',
    })
    const historical = selectVatFiscalPeriod('company-1', 'fp-historical', {
      id: 'fp-historical',
      company_id: 'company-1',
      period_end: '2024-12-31',
    })

    expect(buildVatReportRequest('yearly', 2026, 1, initial)?.year).toBe(2026)
    expect(buildVatReportRequest('yearly', 2026, 1, historical)).toEqual({
      periodType: 'yearly',
      year: 2024,
      period: 1,
      fiscalPeriodId: 'fp-historical',
    })
  })

  it('uses the exact end year for a current broken fiscal year crossing calendar years', () => {
    const selection = selectVatFiscalPeriod('company-1', 'fp-broken', {
      id: 'fp-broken',
      company_id: 'company-1',
      period_end: '2027-06-30',
    })

    expect(buildVatReportRequest('yearly', 2026, 1, selection)?.year).toBe(2027)
  })

  it.each([
    ['monthly', 2024, 11],
    ['quarterly', 2023, 4],
  ] as const)('leaves %s calendar requests unaffected', (periodType, year, period) => {
    expect(buildVatReportRequest(periodType, year, period, null)).toEqual({
      periodType,
      year,
      period,
    })
  })

  it.each([
    ['missing evidence', 'fp-2025', null],
    ['stale mismatched evidence', 'fp-2025', { id: 'fp-other', company_id: 'company-1', period_end: '2025-12-31' }],
    ['other-company evidence', 'fp-2025', { id: 'fp-2025', company_id: 'company-2', period_end: '2025-12-31' }],
    ['invalid end date', 'fp-2025', { id: 'fp-2025', company_id: 'company-1', period_end: '2025-02-31' }],
  ])('fails closed for annual requests with %s', (_label, id, fiscalPeriod) => {
    const selection = selectVatFiscalPeriod('company-1', id, fiscalPeriod)

    expect(selection).toBeNull()
    expect(buildVatReportRequest('yearly', 2026, 1, selection)).toBeNull()
  })
})
