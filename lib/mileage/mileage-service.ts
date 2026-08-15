import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateMileageTripInput,
  MileagePeriodSummary,
  MileageTrip,
  MileageVehicleType,
} from '@/types'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { loadPayrollConfig, type PayrollConfig } from '@/lib/salary/payroll-config'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { roundOre } from '@/lib/money'

/**
 * Körjournal service: trip log per Skatteverket documentation requirements
 * and milersättning booking.
 *
 * Rates come from the DB-driven payroll config (salary_payroll_config), never
 * hardcoded. V1 always reimburses at exactly the tax-free schablon, so no
 * taxable excess arises; the 7332 path exists in the salary module for
 * companies that pay above schablon through payroll.
 */

const KM_PER_MIL = 10

/** BAS 7331: skattefria bilersättningar. */
const MILEAGE_TAXFREE_ACCOUNT = getLineItemAccount('mileage_taxfree')

/** Counter accounts a mileage verifikat may credit. */
export const MILEAGE_COUNTER_ACCOUNTS = ['2820', '2893', '1930'] as const
export type MileageCounterAccount = (typeof MILEAGE_COUNTER_ACCOUNTS)[number]

const round2 = roundOre

const CLAIM_MILEAGE_FOR_SALARY_RPC = 'claim_mileage_trips_for_salary'
const DELETE_DRAFT_SALARY_OBJECT_RPC = 'delete_draft_salary_object_with_mileage_release'

type RpcError = { code?: string; message?: string }

type MileageJournalIdentity = {
  journalEntryId?: string
  voucherNumber?: number | null
  voucherSeries?: string | null
}

export class MileageRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'MileageRpcError'
  }
}

function rpcRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null
}

function isSerializationConflict(error: RpcError | null): boolean {
  return error?.code === '40001' || error?.code === '40P01'
}

function postCommitIdentity(error: unknown): MileageJournalIdentity | null {
  if (!error || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  const code = record.code
  if (
    code !== 'POST_COMMIT_IDENTITY_AMBIGUOUS' &&
    code !== 'JOURNAL_POST_COMMIT_IDENTITY_AMBIGUOUS' &&
    code !== 'JOURNAL_POST_COMMIT_READBACK_FAILED'
  ) {
    return null
  }

  const details =
    record.details && typeof record.details === 'object'
      ? (record.details as Record<string, unknown>)
      : record
  const journalEntryId = details.journalEntryId ?? details.journal_entry_id
  const voucherNumber = details.voucherNumber ?? details.voucher_number
  const voucherSeries = details.voucherSeries ?? details.voucher_series

  return {
    ...(typeof journalEntryId === 'string' ? { journalEntryId } : {}),
    ...(typeof voucherNumber === 'number' || voucherNumber === null
      ? { voucherNumber }
      : {}),
    ...(typeof voucherSeries === 'string' || voucherSeries === null
      ? { voucherSeries }
      : {}),
  }
}

export function ratePerMil(config: PayrollConfig, vehicleType: MileageVehicleType): number {
  switch (vehicleType) {
    case 'own_car':
      return config.milersattningEgenBil
    case 'company_car_fossil':
      return config.milersattningFormansbilFossil
    case 'company_car_electric':
      return config.milersattningFormansbilEl
  }
}

const VEHICLE_TYPE_LABELS: Record<MileageVehicleType, string> = {
  own_car: 'egen bil',
  company_car_fossil: 'förmånsbil (bensin/diesel)',
  company_car_electric: 'förmånsbil (el)',
}

/**
 * Aggregate trips into per-vehicle-type totals at the schablon rate.
 * Amounts are rounded once per vehicle-type group (cents-integer math),
 * so the group amounts sum exactly to the verifikat total.
 */
export function summarizeTrips(
  trips: Pick<MileageTrip, 'vehicle_type' | 'distance_km'>[],
  config: PayrollConfig
): MileagePeriodSummary[] {
  const groups = new Map<MileageVehicleType, { km: number; count: number }>()
  for (const trip of trips) {
    const group = groups.get(trip.vehicle_type) || { km: 0, count: 0 }
    group.km = round2(group.km + Number(trip.distance_km))
    group.count += 1
    groups.set(trip.vehicle_type, group)
  }

  const summaries: MileagePeriodSummary[] = []
  for (const [vehicleType, group] of groups) {
    const mil = round2(group.km / KM_PER_MIL)
    const rate = ratePerMil(config, vehicleType)
    summaries.push({
      vehicle_type: vehicleType,
      trip_count: group.count,
      total_km: group.km,
      total_mil: mil,
      rate_per_mil: rate,
      amount: round2(mil * rate),
    })
  }
  return summaries.sort((a, b) => a.vehicle_type.localeCompare(b.vehicle_type))
}

export interface ListTripsFilter {
  from?: string
  to?: string
  status?: 'draft' | 'booked'
  employeeId?: string
}

export async function listTrips(
  supabase: SupabaseClient,
  companyId: string,
  filter: ListTripsFilter = {}
): Promise<MileageTrip[]> {
  return fetchAllRows<MileageTrip>(({ from, to }) => {
    let query = supabase
      .from('mileage_trips')
      .select('*')
      .eq('company_id', companyId)
      .order('trip_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to)
    if (filter.from) query = query.gte('trip_date', filter.from)
    if (filter.to) query = query.lte('trip_date', filter.to)
    if (filter.status) query = query.eq('status', filter.status)
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId)
    return query
  })
}

export async function createTrip(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateMileageTripInput
): Promise<MileageTrip> {
  // A körjournal for a förmånsbil must identify the vehicle: the schablon
  // rate depends on which car was driven, and Skatteverket expects the
  // underlag to name it. Own-car trips may omit it (single private vehicle).
  if ((input.vehicle_type ?? 'own_car') !== 'own_car' && !input.vehicle_registration?.trim()) {
    throw new Error('Ange registreringsnummer för förmånsbilen')
  }
  // The FK on employee_id is not company-scoped; without this check a
  // cross-company employee UUID would attach silently.
  if (input.employee_id) {
    const { data: employee } = await supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', input.employee_id)
      .maybeSingle()
    if (!employee) {
      throw new Error('Den anställda hittades inte i företaget')
    }
  }
  const { data, error } = await supabase
    .from('mileage_trips')
    .insert({
      company_id: companyId,
      user_id: userId,
      employee_id: input.employee_id || null,
      trip_date: input.trip_date,
      vehicle_type: input.vehicle_type || 'own_car',
      vehicle_registration: input.vehicle_registration?.trim() || null,
      odometer_start: input.odometer_start ?? null,
      odometer_end: input.odometer_end ?? null,
      // The column is numeric(10,1): round to what will actually be stored.
      distance_km: Math.round(input.distance_km * 10) / 10,
      from_location: input.from_location.trim(),
      to_location: input.to_location.trim(),
      purpose: input.purpose.trim(),
      visited: input.visited?.trim() || null,
      is_round_trip: input.is_round_trip ?? false,
      notes: input.notes?.trim() || null,
      created_via: input.created_via || 'manual',
    })
    .select()
    .single()

  if (error || !data) {
    throw new Error(`Failed to create mileage trip: ${error?.message ?? 'no row returned'}`)
  }
  return data as MileageTrip
}

export type BookMileageResult =
  | {
      ok: true
      journalEntryId: string
      voucherNumber: number | null
      voucherSeries: string | null
      tripCount: number
      totalAmount: number
      summaries: MileagePeriodSummary[]
    }
  | {
      ok: false
      code:
        | 'NO_TRIPS'
        | 'MIXED_EMPLOYEES'
        | 'PERIOD_NOT_OPEN'
        | 'CLAIM_LOST'
        | 'TRIPS_CHANGED'
        | 'RELEASE_INCOMPLETE'
        | 'POST_COMMIT_IDENTITY_AMBIGUOUS'
        | 'STAMP_FAILED'
      journalEntryId?: string
      voucherNumber?: number | null
      voucherSeries?: string | null
    }

/**
 * Book all draft trips in [from, to] as one milersättning verifikat:
 * debit 7331 per vehicle type, credit the chosen counter account
 * (2820 skuld till anställda, 2893 avräkning aktieägare, or 1930 when the
 * payout already left the bank). Trips are stamped booked + linked to the
 * verifikat afterwards; the trip rows are the körjournal underlag (7-year
 * retention via DB trigger).
 */
export async function bookMileagePeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    from: string
    to: string
    counterAccount: MileageCounterAccount
    entryDate: string
    employeeId?: string
    createdVia?: 'manual' | 'mcp'
    /**
     * When set (staged MCP approvals), the commit only proceeds if the
     * current draft-trip set matches exactly what was previewed at staging
     * time: otherwise the approved amount and the booked amount could drift.
     */
    expectedTripIds?: string[]
  }
): Promise<BookMileageResult> {
  // Rates are per calendar year; a period spanning a year boundary would book
  // every trip at one year's schablon. Callers book per year (schema-enforced
  // in the API; belt-and-braces here for direct service callers).
  if (params.from.slice(0, 4) !== params.to.slice(0, 4)) {
    throw new Error('Milersättning bokförs per kalenderår: dela upp perioden per år')
  }

  // Release orphaned claims from a crashed earlier booking (status booked,
  // no verifikat, no salary run) so their trips become bookable again. The
  // 5-minute age guard keeps a concurrent in-flight booking's claim safe.
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  await supabase
    .from('mileage_trips')
    .update({ status: 'draft' })
    .eq('company_id', companyId)
    .eq('status', 'booked')
    .is('journal_entry_id', null)
    .is('salary_run_id', null)
    .lt('updated_at', staleBefore)
    .gte('trip_date', params.from)
    .lte('trip_date', params.to)

  const trips = await listTrips(supabase, companyId, {
    from: params.from,
    to: params.to,
    status: 'draft',
    employeeId: params.employeeId,
  })
  if (trips.length === 0) {
    return { ok: false, code: 'NO_TRIPS' }
  }

  if (params.expectedTripIds) {
    const expected = new Set(params.expectedTripIds)
    const actual = new Set(trips.map((t) => t.id))
    const sameSet =
      expected.size === actual.size && [...expected].every((id) => actual.has(id))
    if (!sameSet) {
      return { ok: false, code: 'TRIPS_CHANGED' }
    }
  }

  // BFL 5 kap 6-7 §: the verifikat must identify its motpart. A single lump
  // credit on 2820 covering several employees' reimbursements loses that, so
  // a period spanning more than one employee (unassigned trips count as the
  // owner's) must be booked per employee via the employeeId filter.
  const distinctEmployees = new Set(trips.map((t) => t.employee_id ?? 'unassigned'))
  if (distinctEmployees.size > 1) {
    return { ok: false, code: 'MIXED_EMPLOYEES' }
  }

  const period = await resolvePeriodStatusForDate(supabase, companyId, params.entryDate)
  if (period.status !== 'open' || !period.period_id) {
    return { ok: false, code: 'PERIOD_NOT_OPEN' }
  }

  // Date-only strings parse as UTC midnight; getFullYear() reads local time
  // and lands in the previous year for January dates in negative UTC offsets.
  const config = await loadPayrollConfig(supabase, Number(params.to.slice(0, 4)))
  const summaries = summarizeTrips(trips, config)
  const totalAmount = round2(summaries.reduce((sum, s) => sum + s.amount, 0))
  const totalMil = round2(summaries.reduce((sum, s) => sum + s.total_mil, 0))

  // Name the motpart in the verifikationstext when the period is scoped to an
  // employee (BFL 5 kap 7 §): the trip rows carry the id, the verifikat the name.
  let motpart = ''
  const employeeId = params.employeeId ?? trips[0].employee_id
  if (employeeId) {
    const { data: employee } = await supabase
      .from('employees')
      .select('first_name, last_name')
      .eq('company_id', companyId)
      .eq('id', employeeId)
      .maybeSingle()
    if (employee) motpart = `, ${employee.first_name} ${employee.last_name}`
  }

  // Claim the trips BEFORE creating the verifikat: the draft→booked CAS is
  // what makes a concurrent second booking (double-click, retry, two users)
  // lose the race instead of producing a duplicate verifikat for the same
  // trips. A partially lost race (someone claimed a subset first) aborts and
  // reverts rather than booking a set nobody previewed.
  const tripIds = trips.map((t) => t.id)
  const { data: claimed, error: claimError } = await supabase
    .from('mileage_trips')
    .update({ status: 'booked' })
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .in('id', tripIds)
    .select('id')

  if (claimError) {
    throw new Error(`Failed to claim mileage trips: ${claimError.message}`)
  }
  const claimedIds = (claimed ?? []).map((row) => row.id as string)
  const releaseClaim = async (): Promise<boolean> => {
    if (claimedIds.length === 0) return true
    const { data: released, error: releaseError } = await supabase
      .from('mileage_trips')
      .update({ status: 'draft' })
      .eq('company_id', companyId)
      .eq('status', 'booked')
      .is('journal_entry_id', null)
      .in('id', claimedIds)
      .select('id')
    return !releaseError && (released?.length ?? 0) === claimedIds.length
  }
  if (claimedIds.length !== tripIds.length) {
    // A concurrent booking claimed part of the set first. Verify that our
    // partial claim was released before telling the caller a retry is safe.
    if (!(await releaseClaim())) {
      return { ok: false, code: 'RELEASE_INCOMPLETE' }
    }
    return { ok: false, code: 'CLAIM_LOST' }
  }

  let entry
  try {
    entry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: period.period_id,
      entry_date: params.entryDate,
      description: `Milersättning ${params.from} till ${params.to} (${trips.length} resor, ${totalMil} mil${motpart})`,
      source_type: 'manual',
      lines: [
        ...summaries.map((s) => ({
          account_number: MILEAGE_TAXFREE_ACCOUNT,
          debit_amount: s.amount,
          credit_amount: 0,
          line_description: `Milersättning ${VEHICLE_TYPE_LABELS[s.vehicle_type]}: ${s.total_mil} mil × ${s.rate_per_mil} kr`,
        })),
        {
          account_number: params.counterAccount,
          debit_amount: 0,
          credit_amount: totalAmount,
          line_description: 'Milersättning att utbetala',
        },
      ],
    })
  } catch (err) {
    const identity = postCommitIdentity(err)
    if (identity) {
      // The journal boundary may already have committed. Releasing the claim
      // here could make the same trips bookable again, so fail closed.
      return { ok: false, code: 'POST_COMMIT_IDENTITY_AMBIGUOUS', ...identity }
    }
    if (!(await releaseClaim())) {
      return { ok: false, code: 'RELEASE_INCOMPLETE' }
    }
    throw err
  }

  const { data: linked, error: linkError } = await supabase
    .from('mileage_trips')
    .update({ journal_entry_id: entry.id })
    .eq('company_id', companyId)
    .eq('status', 'booked')
    .in('id', claimedIds)
    .select('id')

  if (linkError || !linked || linked.length !== claimedIds.length) {
    // The verifikat exists. This is terminal until an operator reconciles the
    // trip stamps, and its durable identity must survive the failed readback.
    return {
      ok: false,
      code: 'STAMP_FAILED',
      journalEntryId: entry.id,
      voucherNumber: entry.voucher_number ?? null,
      voucherSeries: entry.voucher_series ?? null,
    }
  }

  return {
    ok: true,
    journalEntryId: entry.id,
    voucherNumber: entry.voucher_number ?? null,
    voucherSeries: entry.voucher_series ?? null,
    tripCount: trips.length,
    totalAmount,
    summaries,
  }
}

export type PushToSalaryRunResult =
  | { ok: true; tripCount: number; totalAmount: number; summaries: MileagePeriodSummary[] }
  | {
      ok: false
      code:
        | 'NO_TRIPS'
        | 'RUN_NOT_FOUND'
        | 'RUN_NOT_EDITABLE'
        | 'EMPLOYEE_NOT_IN_RUN'
        | 'CLAIM_LOST'
    }

interface SalaryMileageClaim {
  trip_ids: string[]
  line_item: {
    item_type: 'mileage_taxfree'
    description: string
    quantity: number
    unit_price: number
    amount: number
    is_taxable: false
    is_avgift_basis: false
    is_vacation_basis: false
    account_number: string
    sort_order: number
  }
}

interface ClaimMileageRpcResult {
  outcome: 'claimed' | 'conflict' | 'run_not_found' | 'run_not_draft' | 'employee_not_in_run'
  claimed_trip_count?: number
  created_line_item_count?: number
}

/**
 * Push the period's draft trips into a draft salary run as tax-free mileage.
 * Claiming trips, inserting each salary line, and linking exact provenance are
 * one M6 transaction. There is deliberately no application compensation path.
 */
export async function pushMileageToSalaryRun(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    runId: string
    employeeId: string
    from: string
    to: string
    includeUnassigned?: boolean
  }
): Promise<PushToSalaryRunResult> {
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', params.runId)
    .eq('company_id', companyId)
    .single()
  if (!run) return { ok: false, code: 'RUN_NOT_FOUND' }
  if (run.status !== 'draft') {
    return { ok: false, code: 'RUN_NOT_EDITABLE' }
  }

  const { data: sre } = await supabase
    .from('salary_run_employees')
    .select('id')
    .eq('salary_run_id', params.runId)
    .eq('employee_id', params.employeeId)
    .eq('company_id', companyId)
    .single()
  if (!sre) return { ok: false, code: 'EMPLOYEE_NOT_IN_RUN' }

  const all = await listTrips(supabase, companyId, {
    from: params.from,
    to: params.to,
    status: 'draft',
  })
  const includeUnassigned = params.includeUnassigned ?? true
  const trips = all.filter(
    (trip) =>
      trip.employee_id === params.employeeId ||
      (includeUnassigned && trip.employee_id === null)
  )
  if (trips.length === 0) return { ok: false, code: 'NO_TRIPS' }

  const config = await loadPayrollConfig(supabase, Number(params.to.slice(0, 4)))
  const summaries = summarizeTrips(trips, config)
  const totalAmount = round2(summaries.reduce((sum, summary) => sum + summary.amount, 0))
  const claims: SalaryMileageClaim[] = summaries.map((summary, index) => ({
    trip_ids: trips
      .filter((trip) => trip.vehicle_type === summary.vehicle_type)
      .map((trip) => trip.id)
      .sort(),
    line_item: {
      item_type: 'mileage_taxfree',
      description: `Milersättning ${VEHICLE_TYPE_LABELS[summary.vehicle_type]} ${params.from} till ${params.to} (${summary.trip_count} resor)`,
      quantity: summary.total_mil,
      unit_price: summary.rate_per_mil,
      amount: summary.amount,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      account_number: MILEAGE_TAXFREE_ACCOUNT,
      sort_order: 100 + index,
    },
  }))

  const { data, error } = await supabase.rpc(CLAIM_MILEAGE_FOR_SALARY_RPC, {
    p_company_id: companyId,
    p_salary_run_id: params.runId,
    p_salary_run_employee_id: sre.id,
    p_claims: claims,
  })
  if (error) {
    if (isSerializationConflict(error)) return { ok: false, code: 'CLAIM_LOST' }
    throw new MileageRpcError(
      'MILEAGE_CLAIM_FAILED',
      error.message || 'Mileage salary claim RPC failed',
      false,
    )
  }

  const result = rpcRow(data) as ClaimMileageRpcResult | null
  switch (result?.outcome) {
    case 'conflict':
      return { ok: false, code: 'CLAIM_LOST' }
    case 'run_not_found':
      return { ok: false, code: 'RUN_NOT_FOUND' }
    case 'run_not_draft':
      return { ok: false, code: 'RUN_NOT_EDITABLE' }
    case 'employee_not_in_run':
      return { ok: false, code: 'EMPLOYEE_NOT_IN_RUN' }
    case 'claimed':
      if (
        result.claimed_trip_count !== trips.length ||
        result.created_line_item_count !== claims.length
      ) {
        throw new MileageRpcError(
          'MILEAGE_CLAIM_RESULT_INCOMPLETE',
          'Mileage claim RPC returned an incomplete committed result',
          false,
          {
            expected_trip_count: trips.length,
            claimed_trip_count: result.claimed_trip_count,
            expected_line_item_count: claims.length,
            created_line_item_count: result.created_line_item_count,
          },
        )
      }
      return { ok: true, tripCount: trips.length, totalAmount, summaries }
    default:
      throw new MileageRpcError(
        'MILEAGE_CLAIM_RESULT_INVALID',
        'Mileage claim RPC returned an invalid result',
        false,
      )
  }
}

export type DraftSalaryObjectTarget =
  | { kind: 'line_item'; id: string }
  | { kind: 'run_employee'; id: string }
  | { kind: 'run'; id: string }

export type DeleteDraftSalaryObjectResult =
  | { ok: true; releasedTripCount: number }
  | {
      ok: false
      code:
        | 'NOT_FOUND'
        | 'NOT_DRAFT'
        | 'MILEAGE_CLAIM_CONFLICT'
        | 'MILEAGE_CLAIM_RELEASE_INCOMPLETE'
        | 'INTERNAL_ERROR'
      details?: Record<string, unknown>
    }

interface DeleteDraftSalaryObjectRpcResult {
  outcome: 'deleted' | 'not_found' | 'not_draft' | 'conflict' | 'release_incomplete'
  released_trip_count?: number
  expected_trip_count?: number
  current_status?: string
}

/**
 * Atomically release exact, unposted mileage claims and delete one draft
 * salary object. M6 owns authorization, row locks, provenance checks, and the
 * mutation. Callers must never replace this with multiple table writes.
 */
export async function deleteDraftSalaryObjectWithMileageRelease(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
  target: DraftSalaryObjectTarget,
): Promise<DeleteDraftSalaryObjectResult> {
  const { data, error } = await supabase.rpc(DELETE_DRAFT_SALARY_OBJECT_RPC, {
    p_company_id: companyId,
    p_salary_run_id: salaryRunId,
    p_target_kind: target.kind,
    p_target_id: target.id,
  })

  if (error) {
    if (isSerializationConflict(error)) {
      return { ok: false, code: 'MILEAGE_CLAIM_CONFLICT' }
    }
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      details: { message: error.message || 'Mileage claim release RPC failed' },
    }
  }

  const result = rpcRow(data) as DeleteDraftSalaryObjectRpcResult | null
  switch (result?.outcome) {
    case 'deleted':
      return { ok: true, releasedTripCount: result.released_trip_count ?? 0 }
    case 'not_found':
      return { ok: false, code: 'NOT_FOUND' }
    case 'not_draft':
      return {
        ok: false,
        code: 'NOT_DRAFT',
        details: { current_status: result.current_status },
      }
    case 'conflict':
      return { ok: false, code: 'MILEAGE_CLAIM_CONFLICT' }
    case 'release_incomplete':
      return {
        ok: false,
        code: 'MILEAGE_CLAIM_RELEASE_INCOMPLETE',
        details: {
          expected_trip_count: result.expected_trip_count,
          released_trip_count: result.released_trip_count,
        },
      }
    default:
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        details: { message: 'Mileage claim release RPC returned an invalid result' },
      }
  }
}
