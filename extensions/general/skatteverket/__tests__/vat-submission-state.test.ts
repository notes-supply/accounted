import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseVatSubmissionState,
  resolveVatSubmissionDeadlineIdentity,
} from '../lib/vat-submission-state'

function monthlyState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'draft_locked',
    redovisare: '165560000000',
    redovisningsperiod: '202606',
    periodType: 'monthly',
    year: 2026,
    period: 6,
    resolvedPeriodStart: '2026-06-01',
    resolvedPeriodEnd: '2026-06-30',
    fiscalPeriodId: null,
    fiscalPeriodStart: null,
    fiscalPeriodEnd: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseVatSubmissionState', () => {
  it('accepts exact canonical monthly identity', () => {
    expect(parseVatSubmissionState(monthlyState())).toMatchObject({
      periodType: 'monthly',
      year: 2026,
      period: 6,
      redovisningsperiod: '202606',
    })
  })

  it('accepts a liability-clamped monthly start within the exact calendar month', () => {
    expect(parseVatSubmissionState(monthlyState({
      resolvedPeriodStart: '2026-06-15',
    }))).toMatchObject({
      resolvedPeriodStart: '2026-06-15',
      resolvedPeriodEnd: '2026-06-30',
    })
  })

  it.each([
    { label: 'remote month drift', overrides: { period: 5 } },
    { label: 'start before month', overrides: { resolvedPeriodStart: '2026-05-31' } },
    { label: 'start after month', overrides: { resolvedPeriodStart: '2026-07-01' } },
    { label: 'end drift', overrides: { resolvedPeriodEnd: '2026-06-29' } },
    { label: 'malformed start', overrides: { resolvedPeriodStart: '2026-02-30' } },
    { label: 'reverse bounds', overrides: { resolvedPeriodStart: '2026-07-01' } },
    { label: 'invalid year', overrides: { year: 1999 } },
    { label: 'invalid month', overrides: { period: 13 } },
    { label: 'non-canonical fiscal identity', overrides: { fiscalPeriodId: 'fp-forged' } },
    { label: 'missing update timestamp', overrides: { updatedAt: undefined } },
    { label: 'malformed update timestamp', overrides: { updatedAt: 'yesterday' } },
    { label: 'invalid update calendar date', overrides: { updatedAt: '2026-02-30T00:00:00.000Z' } },
    { label: 'malformed redovisare', overrides: { redovisare: 'not-an-org' } },
  ])('rejects monthly $label', ({ overrides }) => {
    expect(() => parseVatSubmissionState(monthlyState(overrides))).toThrow()
  })

  it('accepts exact canonical quarterly identity', () => {
    expect(parseVatSubmissionState(monthlyState({
      redovisningsperiod: '202606',
      periodType: 'quarterly',
      period: 2,
      resolvedPeriodStart: '2026-04-01',
      resolvedPeriodEnd: '2026-06-30',
    }))).toMatchObject({ periodType: 'quarterly', period: 2 })
  })

  it('accepts a liability-clamped quarterly start within the exact calendar quarter', () => {
    expect(parseVatSubmissionState(monthlyState({
      periodType: 'quarterly',
      period: 2,
      resolvedPeriodStart: '2026-05-01',
      resolvedPeriodEnd: '2026-06-30',
    }))).toMatchObject({
      periodType: 'quarterly',
      period: 2,
      resolvedPeriodStart: '2026-05-01',
      resolvedPeriodEnd: '2026-06-30',
    })
  })

  it.each([
    { label: 'remote quarter drift', overrides: { redovisningsperiod: '202605' } },
    { label: 'start before quarter', overrides: { resolvedPeriodStart: '2026-03-31' } },
    { label: 'start after quarter', overrides: { resolvedPeriodStart: '2026-07-01' } },
    { label: 'quarter end drift', overrides: { resolvedPeriodEnd: '2026-06-29' } },
    { label: 'invalid quarter', overrides: { period: 5 } },
  ])('rejects quarterly $label', ({ overrides }) => {
    expect(() => parseVatSubmissionState(monthlyState({
      periodType: 'quarterly',
      period: 2,
      resolvedPeriodStart: '2026-04-01',
      resolvedPeriodEnd: '2026-06-30',
      ...overrides,
    }))).toThrow()
  })

  it('accepts exact annual fiscal-period identity', () => {
    expect(parseVatSubmissionState(monthlyState({
      redovisningsperiod: '202603',
      periodType: 'yearly',
      period: 1,
      resolvedPeriodStart: '2025-04-01',
      resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId: 'fp-annual',
      fiscalPeriodStart: '2025-04-01',
      fiscalPeriodEnd: '2026-03-31',
    }))).toMatchObject({ periodType: 'yearly', fiscalPeriodId: 'fp-annual' })
  })

  it('accepts a liability-clamped annual start within immutable fiscal bounds', () => {
    expect(parseVatSubmissionState(monthlyState({
      redovisningsperiod: '202612',
      periodType: 'yearly',
      period: 1,
      resolvedPeriodStart: '2026-05-01',
      resolvedPeriodEnd: '2026-12-31',
      fiscalPeriodId: 'fp-first-annual',
      fiscalPeriodStart: '2026-04-15',
      fiscalPeriodEnd: '2026-12-31',
    }))).toMatchObject({
      resolvedPeriodStart: '2026-05-01',
      resolvedPeriodEnd: '2026-12-31',
      fiscalPeriodId: 'fp-first-annual',
      fiscalPeriodStart: '2026-04-15',
      fiscalPeriodEnd: '2026-12-31',
    })
  })

  it.each([
    { label: 'missing fiscal id', overrides: { fiscalPeriodId: null } },
    { label: 'resolved start before fiscal bounds', overrides: { resolvedPeriodStart: '2025-03-31' } },
    { label: 'resolved start after fiscal end', overrides: { resolvedPeriodStart: '2026-04-01' } },
    { label: 'fiscal end mismatch', overrides: { fiscalPeriodEnd: '2026-02-28' } },
    { label: 'remote end-month drift', overrides: { redovisningsperiod: '202602' } },
    { label: 'end-year drift', overrides: { year: 2025 } },
    { label: 'invalid annual ordinal', overrides: { period: 2 } },
  ])('rejects annual $label', ({ overrides }) => {
    expect(() => parseVatSubmissionState(monthlyState({
      redovisningsperiod: '202603',
      periodType: 'yearly',
      period: 1,
      resolvedPeriodStart: '2025-04-01',
      resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId: 'fp-annual',
      fiscalPeriodStart: '2025-04-01',
      fiscalPeriodEnd: '2026-03-31',
      ...overrides,
    }))).toThrow()
  })
})

describe('resolveVatSubmissionDeadlineIdentity', () => {
  it('company-scopes annual fiscal identity and requires exact stored bounds', async () => {
    const eq = vi.fn().mockReturnThis()
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'fp-first-annual',
        period_start: '2026-04-15',
        period_end: '2026-12-31',
      },
      error: null,
    })
    const select = vi.fn(() => ({ eq, maybeSingle }))
    const from = vi.fn(() => ({ select }))
    const supabase = { from } as unknown as SupabaseClient

    const result = await resolveVatSubmissionDeadlineIdentity(
      supabase,
      'company-notes-supply',
      monthlyState({
        redovisningsperiod: '202612',
        periodType: 'yearly',
        period: 1,
        resolvedPeriodStart: '2026-05-01',
        resolvedPeriodEnd: '2026-12-31',
        fiscalPeriodId: 'fp-first-annual',
        fiscalPeriodStart: '2026-04-15',
        fiscalPeriodEnd: '2026-12-31',
      }),
    )

    expect(eq).toHaveBeenNthCalledWith(1, 'id', 'fp-first-annual')
    expect(eq).toHaveBeenNthCalledWith(2, 'company_id', 'company-notes-supply')
    expect(result).toMatchObject({
      type: 'moms_yearly',
      fiscalPeriodId: 'fp-first-annual',
      fiscalPeriodStart: '2026-04-15',
      fiscalPeriodEnd: '2026-12-31',
    })
  })

  it('rejects annual fiscal bounds that drift from the company-scoped row', async () => {
    const eq = vi.fn().mockReturnThis()
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'fp-first-annual',
        period_start: '2026-04-15',
        period_end: '2026-12-31',
      },
      error: null,
    })
    const select = vi.fn(() => ({ eq, maybeSingle }))
    const supabase = {
      from: vi.fn(() => ({ select })),
    } as unknown as SupabaseClient

    await expect(resolveVatSubmissionDeadlineIdentity(
      supabase,
      'company-notes-supply',
      monthlyState({
        redovisningsperiod: '202612',
        periodType: 'yearly',
        period: 1,
        resolvedPeriodStart: '2026-05-01',
        resolvedPeriodEnd: '2026-12-31',
        fiscalPeriodId: 'fp-first-annual',
        fiscalPeriodStart: '2026-04-01',
        fiscalPeriodEnd: '2026-12-31',
      }),
    )).rejects.toThrow('Annual VAT fiscal period identity drift detected')

    expect(eq).toHaveBeenNthCalledWith(1, 'id', 'fp-first-annual')
    expect(eq).toHaveBeenNthCalledWith(2, 'company_id', 'company-notes-supply')
  })
})
