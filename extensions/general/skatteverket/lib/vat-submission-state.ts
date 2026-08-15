import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclarationRutor, VatPeriodType } from '@/types'
import type { VatResolvedPeriod } from '@/lib/reports/vat-declaration'
import { resolveCanonicalVatDeadline } from '@/lib/tax/deadline-config'
import type { SkatteverketMomsuppgift } from '../types'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'
import { rutorToMomsuppgift } from './mappers'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUTA_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31',
  'ruta32', 'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40',
  'ruta41', 'ruta42', 'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61',
  'ruta62',
] as const satisfies readonly (keyof VatDeclarationRutor)[]
const MOMSUPPGIFT_KEYS = new Set([
  'momspliktigForsaljning',
  'momspliktigaUttag',
  'vinstmarginal',
  'hyresInkomst',
  'momsForsaljningUtgaendeHog',
  'momsForsaljningUtgaendeMedel',
  'momsForsaljningUtgaendeLag',
  'inkopVarorEU',
  'inkopTjansterEU',
  'inkopTjansterUtanforEU',
  'inkopVarorSE',
  'inkopTjansterSE',
  'momsInkopUtgaendeHog',
  'momsInkopUtgaendeMedel',
  'momsInkopUtgaendeLag',
  'forsaljningVarorEU',
  'forsaljningVarorUtanforEU',
  'inkopVaror3pHandel',
  'forsaljningVaror3pHandel',
  'forsaljningTjansterEU',
  'ovrigForsaljningTjansterUtanforSE',
  'forsaljningBskKopareSE',
  'momsfriForsaljning',
  'ingaendeMomsAvdrag',
  'import',
  'momsImportUtgaendeHog',
  'momsImportUtgaendeMedel',
  'momsImportUtgaendeLag',
  'summaMoms',
])
const STATE_KEYS = new Set([
  'redovisare',
  'redovisningsperiod',
  'periodType',
  'year',
  'period',
  'resolvedPeriodStart',
  'resolvedPeriodEnd',
  'originalPeriodStart',
  'originalPeriodEnd',
  'fiscalPeriodId',
  'fiscalPeriodStart',
  'fiscalPeriodEnd',
  'vatLiabilityStartDate',
  'approvedRutor',
  'approvedMomsuppgift',
  'status',
  'updatedAt',
  'kontrollresultat',
  'signeringsLank',
  'kvittensnummer',
  'tidpunkt',
])

export type VatSubmissionStatus =
  | 'draft_saved'
  | 'draft_locked'
  | 'signed'
  | 'submitted'
  | 'decided'

export interface VatSubmissionIdentity {
  redovisare: string
  redovisningsperiod: string
  periodType: VatPeriodType
  year: number
  period: number
  resolvedPeriodStart: string
  resolvedPeriodEnd: string
  originalPeriodStart: string
  originalPeriodEnd: string
  fiscalPeriodId: string | null
  fiscalPeriodStart: string | null
  fiscalPeriodEnd: string | null
  vatLiabilityStartDate: string | null
  approvedRutor: VatDeclarationRutor
  approvedMomsuppgift: SkatteverketMomsuppgift
}

export interface VatSubmissionState extends VatSubmissionIdentity {
  status: VatSubmissionStatus
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
  linkedReportPeriod: Record<string, unknown>
}

export class VatSubmissionConflictError extends Error {
  readonly status = 409
  readonly code = 'VAT_SUBMISSION_IDENTITY_DRIFT'

  constructor(message: string) {
    super(message)
    this.name = 'VatSubmissionConflictError'
  }
}


function assertIsoDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
}

function canonicalNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`VAT submission state has invalid ${field}`)
  }
  return roundOre(value)
}

export function canonicalVatRutor(value: unknown): VatDeclarationRutor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Approved VAT rutor are unavailable')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input)
  if (
    keys.length !== RUTA_KEYS.length
    || keys.some((key) => !RUTA_KEYS.includes(key as keyof VatDeclarationRutor))
  ) {
    throw new Error('Approved VAT rutor have an invalid shape')
  }
  const result = {} as VatDeclarationRutor
  for (const key of RUTA_KEYS) result[key] = canonicalNumber(input[key], key)
  return result
}

export function canonicalMomsuppgift(value: unknown): SkatteverketMomsuppgift {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Approved momsuppgift is unavailable')
  }
  const input = value as Record<string, unknown>
  if (!Object.hasOwn(input, 'summaMoms')) {
    throw new Error('Approved momsuppgift lacks summaMoms')
  }
  const result: Record<string, number> = {}
  for (const key of Object.keys(input).sort()) {
    const amount = input[key]
    if (
      !MOMSUPPGIFT_KEYS.has(key)
      || typeof amount !== 'number'
      || !Number.isFinite(amount)
      || !Number.isInteger(amount)
    ) {
      throw new Error(`Approved momsuppgift has invalid ${key}`)
    }
    result[key] = amount
  }
  return result as SkatteverketMomsuppgift
}

function stableIdentity(identity: VatSubmissionIdentity): string {
  return JSON.stringify({
    redovisare: identity.redovisare,
    redovisningsperiod: identity.redovisningsperiod,
    periodType: identity.periodType,
    year: identity.year,
    period: identity.period,
    resolvedPeriodStart: identity.resolvedPeriodStart,
    resolvedPeriodEnd: identity.resolvedPeriodEnd,
    originalPeriodStart: identity.originalPeriodStart,
    originalPeriodEnd: identity.originalPeriodEnd,
    fiscalPeriodId: identity.fiscalPeriodId,
    fiscalPeriodStart: identity.fiscalPeriodStart,
    fiscalPeriodEnd: identity.fiscalPeriodEnd,
    vatLiabilityStartDate: identity.vatLiabilityStartDate,
    approvedRutor: canonicalVatRutor(identity.approvedRutor),
    approvedMomsuppgift: canonicalMomsuppgift(identity.approvedMomsuppgift),
  })
}

export function vatSubmissionIdentity(input: {
  redovisare: string
  redovisningsperiod: string
  period: VatResolvedPeriod
  approvedRutor: VatDeclarationRutor
  approvedMomsuppgift: SkatteverketMomsuppgift
}): VatSubmissionIdentity {
  return {
    redovisare: input.redovisare,
    redovisningsperiod: input.redovisningsperiod,
    periodType: input.period.type,
    year: input.period.year,
    period: input.period.period,
    resolvedPeriodStart: input.period.start,
    resolvedPeriodEnd: input.period.end,
    originalPeriodStart: input.period.originalStart,
    originalPeriodEnd: input.period.originalEnd,
    fiscalPeriodId: input.period.fiscalPeriodId,
    fiscalPeriodStart: input.period.fiscalPeriodStart,
    fiscalPeriodEnd: input.period.fiscalPeriodEnd,
    vatLiabilityStartDate: input.period.vatLiabilityStartDate,
    approvedRutor: canonicalVatRutor(input.approvedRutor),
    approvedMomsuppgift: canonicalMomsuppgift(input.approvedMomsuppgift),
  }
}

export function createVatSubmissionState(
  identity: VatSubmissionIdentity,
  status: VatSubmissionStatus,
  details: Partial<Omit<VatSubmissionState, keyof VatSubmissionIdentity | 'status' | 'updatedAt'>> = {},
): VatSubmissionState {
  const state = {
    ...identity,
    ...details,
    status,
    updatedAt: new Date().toISOString(),
  } as VatSubmissionState
  assertSameVatSubmissionIdentity(state, identity)
  return parseVatSubmissionState(state)
}

export function parseVatSubmissionState(value: unknown): VatSubmissionState {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error('VAT submission state is malformed')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VAT submission state is unavailable')
  }
  const state = parsed as Partial<VatSubmissionState>
  if (Object.keys(parsed).some((key) => !STATE_KEYS.has(key))) {
    throw new Error('VAT submission state has unknown fields')
  }
  const validPeriodType = ['monthly', 'quarterly', 'yearly'].includes(state.periodType ?? '')
  const maximumPeriod = state.periodType === 'monthly'
    ? 12
    : state.periodType === 'quarterly'
      ? 4
      : 1
  if (
    !['draft_saved', 'draft_locked', 'signed', 'submitted', 'decided'].includes(state.status ?? '')
    || typeof state.redovisare !== 'string'
    || !/^\d{12}$/.test(state.redovisare)
    || typeof state.redovisningsperiod !== 'string'
    || !/^\d{6}$/.test(state.redovisningsperiod)
    || !validPeriodType
    || !Number.isInteger(state.year)
    || Number(state.year) < 2000
    || Number(state.year) > 2100
    || !Number.isInteger(state.period)
    || Number(state.period) < 1
    || Number(state.period) > maximumPeriod
    || typeof state.updatedAt !== 'string'
    || Number.isNaN(Date.parse(state.updatedAt))
    || new Date(state.updatedAt).toISOString() !== state.updatedAt
  ) {
    throw new Error('VAT submission state lacks immutable identity')
  }

  const exact = state as VatSubmissionState
  assertIsoDate(exact.resolvedPeriodStart, 'resolvedPeriodStart')
  assertIsoDate(exact.resolvedPeriodEnd, 'resolvedPeriodEnd')
  assertIsoDate(exact.originalPeriodStart, 'originalPeriodStart')
  assertIsoDate(exact.originalPeriodEnd, 'originalPeriodEnd')
  const expectedResolvedStart = exact.vatLiabilityStartDate
    && exact.vatLiabilityStartDate > exact.originalPeriodStart
    ? exact.vatLiabilityStartDate
    : exact.originalPeriodStart
  if (
    exact.originalPeriodStart > exact.originalPeriodEnd
    || expectedResolvedStart > exact.originalPeriodEnd
    || exact.resolvedPeriodStart !== expectedResolvedStart
    || exact.resolvedPeriodEnd !== exact.originalPeriodEnd
    || (exact.vatLiabilityStartDate !== null
      && typeof exact.vatLiabilityStartDate !== 'string')
  ) {
    throw new Error('VAT submission state has inconsistent bounds')
  }
  if (exact.vatLiabilityStartDate !== null) {
    assertIsoDate(exact.vatLiabilityStartDate, 'vatLiabilityStartDate')
  }

  exact.approvedRutor = canonicalVatRutor(exact.approvedRutor)
  exact.approvedMomsuppgift = canonicalMomsuppgift(exact.approvedMomsuppgift)
  const expectedMomsuppgift = canonicalMomsuppgift(
    rutorToMomsuppgift(exact.approvedRutor),
  )
  if (
    JSON.stringify(exact.approvedMomsuppgift)
    !== JSON.stringify(expectedMomsuppgift)
  ) {
    throw new Error('VAT submission state has inconsistent approved payload')
  }
  if (exact.periodType === 'yearly') {
    if (
      typeof exact.fiscalPeriodId !== 'string'
      || !UUID_PATTERN.test(exact.fiscalPeriodId)
      || exact.fiscalPeriodStart !== exact.originalPeriodStart
      || exact.fiscalPeriodEnd !== exact.originalPeriodEnd
      || Number(exact.fiscalPeriodEnd.slice(0, 4)) !== exact.year
    ) {
      throw new Error('VAT submission state has invalid annual identity')
    }
  } else if (
    exact.fiscalPeriodId !== null
    || exact.fiscalPeriodStart !== null
    || exact.fiscalPeriodEnd !== null
  ) {
    throw new Error('VAT submission state has unexpected fiscal identity')
  }
  if (exact.redovisningsperiod !== `${exact.originalPeriodEnd.slice(0, 4)}${exact.originalPeriodEnd.slice(5, 7)}`) {
    throw new Error('VAT submission state has inconsistent remote period')
  }
  return exact
}

export function assertSameVatSubmissionIdentity(
  current: VatSubmissionIdentity,
  expected: VatSubmissionIdentity,
): void {
  if (stableIdentity(current) !== stableIdentity(expected)) {
    throw new VatSubmissionConflictError('VAT submission identity or approved rutor changed')
  }
}

const ALLOWED_TRANSITIONS: Record<VatSubmissionStatus, readonly VatSubmissionStatus[]> = {
  draft_saved: ['draft_locked'],
  draft_locked: ['draft_saved', 'signed', 'submitted', 'decided'],
  signed: ['submitted', 'decided'],
  submitted: ['decided'],
  decided: [],
}

export function transitionVatSubmissionState(
  state: VatSubmissionState,
  status: VatSubmissionStatus,
  details: Partial<Omit<VatSubmissionState, keyof VatSubmissionIdentity | 'status' | 'updatedAt'>> = {},
): VatSubmissionState {
  const parsed = parseVatSubmissionState(state)
  if (parsed.status !== status && !ALLOWED_TRANSITIONS[parsed.status].includes(status)) {
    throw new VatSubmissionConflictError(
      `Invalid VAT submission transition from ${parsed.status} to ${status}`,
    )
  }
  const next = {
    ...parsed,
    ...details,
    status,
    updatedAt: new Date().toISOString(),
  } as VatSubmissionState
  assertSameVatSubmissionIdentity(next, parsed)
  return parseVatSubmissionState(next)
}

export async function readVatSubmissionState(
  supabase: SupabaseClient,
  companyId: string,
  key: string,
): Promise<VatSubmissionState> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('key, value')
    .eq('company_id', companyId)
    .eq('extension_id', 'skatteverket')
    .eq('key', key)
    .maybeSingle()
  if (error) throw new Error(`Failed to read VAT submission state: ${error.message}`)
  if (!data) throw new Error('VAT submission state is unavailable')
  const state = parseVatSubmissionState(data.value)
  if (data.key !== `submission_${state.redovisningsperiod}` || data.key !== key) {
    throw new VatSubmissionConflictError('VAT submission key identity changed')
  }
  return state
}

export async function resolveVatSubmissionDeadlineIdentity(
  supabase: SupabaseClient,
  companyId: string,
  value: unknown,
): Promise<VatSubmissionDeadlineIdentity> {
  const state = parseVatSubmissionState(value)
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select(
      'entity_type, vat_liability_start_date, vat_taxable_base_over_40m, vat_has_eu_trade, vat_filing_method',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) {
    throw new Error(`Failed to revalidate VAT settings: ${settingsError.message}`)
  }
  if (!settings) throw new Error('VAT deadline settings are unavailable')

  let fiscalPeriod: { id: string; period_start: string; period_end: string } | undefined
  if (state.periodType === 'yearly') {
    const { data, error } = await supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('id', state.fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`Failed to revalidate annual VAT period: ${error.message}`)
    if (!data) {
      throw new VatSubmissionConflictError('Annual VAT fiscal period identity changed')
    }
    fiscalPeriod = data
  }

  const canonical = resolveCanonicalVatDeadline({
    periodType: state.periodType,
    year: state.year,
    period: state.period,
    settings,
    fiscalPeriod,
  })
  if (
    canonical.originalStart !== state.originalPeriodStart
    || canonical.originalEnd !== state.originalPeriodEnd
    || canonical.resolvedStart !== state.resolvedPeriodStart
    || canonical.resolvedEnd !== state.resolvedPeriodEnd
    || canonical.fiscalPeriodId !== state.fiscalPeriodId
    || canonical.fiscalPeriodStart !== state.fiscalPeriodStart
    || canonical.fiscalPeriodEnd !== state.fiscalPeriodEnd
    || canonical.vatLiabilityStartDate !== state.vatLiabilityStartDate
  ) {
    throw new VatSubmissionConflictError('VAT filing or deadline identity changed')
  }
  return {
    state,
    type: canonical.taxDeadlineTypes[0] as VatSubmissionDeadlineIdentity['type'],
    taxPeriod: canonical.taxPeriod,
    linkedReportPeriod: canonical.linkedReportPeriod,
  }
}
