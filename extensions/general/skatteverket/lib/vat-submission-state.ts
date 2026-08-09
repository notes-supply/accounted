import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatPeriodType } from '@/types'
import { parseVatPeriodInput } from '@/lib/vat/period-input'
import { formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { getActualFiscalPeriodLabel } from '@/lib/tax/deadline-config'
import type { VatDeclarationPrep, VatDeclarationPrepInput } from './declaration-prep'

export interface VatSubmissionIdentity {
  redovisare: string
  redovisningsperiod: string
  periodType: VatPeriodType
  year: number
  period: number
  resolvedPeriodStart: string
  resolvedPeriodEnd: string
  fiscalPeriodId: string | null
  fiscalPeriodStart: string | null
  fiscalPeriodEnd: string | null
}

export interface VatSubmissionState extends VatSubmissionIdentity {
  status: string
  updatedAt: string
  kontrollresultat?: unknown
  signeringsLank?: string
  kvittensnummer?: string | null
  tidpunkt?: string | null
}

export interface VatSubmissionDeadlineIdentity {
  state: VatSubmissionState
  type: 'moms_monthly' | 'moms_quarterly' | 'moms_yearly'
  taxPeriod: string
  fiscalPeriodId?: string
  fiscalPeriodStart?: string
  fiscalPeriodEnd?: string
}

export function vatSubmissionIdentity(
  input: VatDeclarationPrepInput,
  prep: VatDeclarationPrep,
): VatSubmissionIdentity {
  const resolvedPeriodStart = prep.resolvedPeriodStart ?? prep.declaration.period.start
  const resolvedPeriodEnd = prep.resolvedPeriodEnd ?? prep.declaration.period.end
  const fiscalPeriodId = prep.fiscalPeriodId ?? prep.declaration.period.fiscalPeriodId ?? null
  const fiscalPeriodStart = prep.fiscalPeriodStart ?? prep.declaration.period.fiscalPeriodStart ??
    (fiscalPeriodId ? resolvedPeriodStart : null)
  const fiscalPeriodEnd = prep.fiscalPeriodEnd ?? prep.declaration.period.fiscalPeriodEnd ??
    (fiscalPeriodId ? resolvedPeriodEnd : null)
  if (!resolvedPeriodStart || !resolvedPeriodEnd) {
    throw new Error('VAT submission period bounds are unavailable')
  }
  if (input.periodType === 'yearly' && (!fiscalPeriodId || !fiscalPeriodStart || !fiscalPeriodEnd)) {
    throw new Error('Annual VAT submission fiscal period identity is unavailable')
  }
  return {
    redovisare: prep.redovisare,
    redovisningsperiod: prep.redovisningsperiod,
    periodType: input.periodType,
    year: input.year,
    period: input.period,
    resolvedPeriodStart,
    resolvedPeriodEnd,
    fiscalPeriodId,
    fiscalPeriodStart,
    fiscalPeriodEnd,
  }
}

export function createVatSubmissionState(
  identity: VatSubmissionIdentity,
  status: string,
  details: Omit<Partial<VatSubmissionState>, keyof VatSubmissionIdentity | 'status' | 'updatedAt'> = {},
): VatSubmissionState {
  return { ...identity, ...details, status, updatedAt: new Date().toISOString() }
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) throw new Error(`VAT submission state has invalid ${field}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
}

function assertIsoInstant(value: unknown, field: string): asserts value is string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (
    typeof value !== 'string' ||
    !ISO_INSTANT_PATTERN.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
}

function calendarPeriodBounds(
  periodType: 'monthly' | 'quarterly',
  year: number,
  period: number,
): { start: string; end: string } {
  const startMonth = periodType === 'monthly' ? period : (period - 1) * 3 + 1
  const endMonth = periodType === 'monthly' ? period : period * 3
  const start = `${year}-${String(startMonth).padStart(2, '0')}-01`
  const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  const end = `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`
  return { start, end }
}

export function parseVatSubmissionState(value: unknown): VatSubmissionState {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('VAT submission state is unavailable')
  }
  const state = parsed as Partial<VatSubmissionState>
  if (
    typeof state.status !== 'string' ||
    state.status.length === 0 ||
    typeof state.redovisare !== 'string' ||
    !/^\d{12}$/.test(state.redovisare) ||
    typeof state.redovisningsperiod !== 'string' ||
    !/^\d{6}$/.test(state.redovisningsperiod) ||
    !['monthly', 'quarterly', 'yearly'].includes(state.periodType ?? '') ||
    !Number.isInteger(state.year) ||
    !Number.isInteger(state.period) ||
    typeof state.resolvedPeriodStart !== 'string' ||
    typeof state.resolvedPeriodEnd !== 'string' ||
    typeof state.updatedAt !== 'string' ||
    (state.periodType === 'yearly' && (
      typeof state.fiscalPeriodId !== 'string' ||
      state.fiscalPeriodId.length === 0 ||
      typeof state.fiscalPeriodStart !== 'string' ||
      typeof state.fiscalPeriodEnd !== 'string'
    ))
  ) {
    throw new Error('VAT submission state lacks immutable period identity')
  }

  const exactState = state as VatSubmissionState
  const period = parseVatPeriodInput({
    periodType: exactState.periodType,
    year: exactState.year,
    period: exactState.period,
  })
  assertIsoDate(exactState.resolvedPeriodStart, 'resolvedPeriodStart')
  assertIsoDate(exactState.resolvedPeriodEnd, 'resolvedPeriodEnd')
  assertIsoInstant(exactState.updatedAt, 'updatedAt')
  if (exactState.resolvedPeriodStart > exactState.resolvedPeriodEnd) {
    throw new Error('VAT submission state period bounds are reversed')
  }

  if (period.periodType === 'monthly' || period.periodType === 'quarterly') {
    if (
      exactState.fiscalPeriodId !== null ||
      exactState.fiscalPeriodStart !== null ||
      exactState.fiscalPeriodEnd !== null
    ) {
      throw new Error('VAT submission state has unexpected fiscal period identity')
    }
    const expectedBounds = calendarPeriodBounds(period.periodType, period.year, period.period)
    const expectedRemotePeriod = formatRedovisningsperiod(
      period.periodType,
      period.year,
      period.period,
    )
    if (
      exactState.resolvedPeriodStart < expectedBounds.start ||
      exactState.resolvedPeriodStart > expectedBounds.end ||
      exactState.resolvedPeriodEnd !== expectedBounds.end ||
      exactState.redovisningsperiod !== expectedRemotePeriod
    ) {
      throw new Error('VAT submission state period identity is inconsistent')
    }
    return exactState
  }

  assertIsoDate(exactState.fiscalPeriodStart, 'fiscalPeriodStart')
  assertIsoDate(exactState.fiscalPeriodEnd, 'fiscalPeriodEnd')
  const endYear = Number(exactState.resolvedPeriodEnd.slice(0, 4))
  const endMonth = Number(exactState.resolvedPeriodEnd.slice(5, 7))
  const expectedRemotePeriod = formatRedovisningsperiod('yearly', period.year, period.period, {
    year: endYear,
    month: endMonth,
  })
  if (
    exactState.fiscalPeriodStart > exactState.fiscalPeriodEnd ||
    exactState.resolvedPeriodStart < exactState.fiscalPeriodStart ||
    exactState.resolvedPeriodStart > exactState.fiscalPeriodEnd ||
    exactState.fiscalPeriodEnd !== exactState.resolvedPeriodEnd ||
    period.year !== endYear ||
    exactState.redovisningsperiod !== expectedRemotePeriod
  ) {
    throw new Error('VAT submission state annual fiscal identity is inconsistent')
  }

  return exactState
}

export function assertVatSubmissionIdentity(
  state: VatSubmissionState,
  expected: Pick<VatSubmissionIdentity, 'redovisare' | 'redovisningsperiod'>,
): void {
  if (
    state.redovisare !== expected.redovisare ||
    state.redovisningsperiod !== expected.redovisningsperiod
  ) {
    throw new Error('VAT submission identity drift detected')
  }
}

export function assertSameVatSubmissionIdentity(
  state: VatSubmissionState,
  identity: VatSubmissionIdentity,
): void {
  for (const key of [
    'redovisare',
    'redovisningsperiod',
    'periodType',
    'year',
    'period',
    'resolvedPeriodStart',
    'resolvedPeriodEnd',
    'fiscalPeriodId',
    'fiscalPeriodStart',
    'fiscalPeriodEnd',
  ] as const) {
    if (state[key] !== identity[key]) {
      throw new Error(`VAT submission identity drift detected at ${key}`)
    }
  }
}

export async function resolveVatSubmissionDeadlineIdentity(
  supabase: SupabaseClient,
  companyId: string,
  value: unknown,
): Promise<VatSubmissionDeadlineIdentity> {
  const state = parseVatSubmissionState(value)
  if (state.periodType === 'monthly') {
    return {
      state,
      type: 'moms_monthly',
      taxPeriod: `${state.year}-${String(state.period).padStart(2, '0')}`,
    }
  }
  if (state.periodType === 'quarterly') {
    return {
      state,
      type: 'moms_quarterly',
      taxPeriod: `${state.year}-Q${state.period}`,
    }
  }

  const { fiscalPeriodId, fiscalPeriodStart, fiscalPeriodEnd } = state
  if (
    typeof fiscalPeriodId !== 'string' ||
    typeof fiscalPeriodStart !== 'string' ||
    typeof fiscalPeriodEnd !== 'string'
  ) {
    throw new Error('Annual VAT submission fiscal period identity is unavailable')
  }

  const { data: fiscalPeriod, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!fiscalPeriod) throw new Error('Annual VAT fiscal period is unavailable')
  if (
    fiscalPeriod.period_start !== fiscalPeriodStart ||
    fiscalPeriod.period_end !== fiscalPeriodEnd
  ) {
    throw new Error('Annual VAT fiscal period identity drift detected')
  }
  return {
    state,
    type: 'moms_yearly',
    taxPeriod: getActualFiscalPeriodLabel(fiscalPeriod.period_start, fiscalPeriod.period_end),
    fiscalPeriodId,
    fiscalPeriodStart,
    fiscalPeriodEnd,
  }
}
