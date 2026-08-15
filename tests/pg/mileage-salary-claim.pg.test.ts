import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool, withUserContext } from './setup'

interface PayrollFixture {
  userId: string
  companyId: string
  employeeId: string
  runId: string
  runEmployeeId: string
  tripIds: [string, string]
}

interface MileageLineItem extends Record<string, unknown> {
  item_type: string
  description: string
  quantity: number
  unit_price: number
  amount: number
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  account_number: string
  sort_order: number
}

interface MileageClaim {
  trip_ids: string[]
  line_item: MileageLineItem
}

async function seedPayrollFixture(): Promise<PayrollFixture> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  const runId = randomUUID()
  const runEmployeeId = randomUUID()
  const tripIds: [string, string] = [randomUUID(), randomUUID()]
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, monthly_salary)
     VALUES ($1, $2, $3, 'Ada', 'Lovelace', $4, '1234', DATE '2026-01-01', 40000)`,
    [employeeId, companyId, userId, `19900101${employeeId.slice(0, 4)}`],
  )
  await getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 8, DATE '2026-08-25', 'draft')`,
    [runId, companyId, userId],
  )
  await getPool().query(
    `INSERT INTO public.salary_run_employees
       (id, salary_run_id, employee_id, company_id, employment_degree,
        monthly_salary, salary_type)
     VALUES ($1, $2, $3, $4, 100, 40000, 'monthly')`,
    [runEmployeeId, runId, employeeId, companyId],
  )
  await getPool().query(
    `INSERT INTO public.mileage_trips
       (id, company_id, user_id, employee_id, trip_date, vehicle_type,
        distance_km, from_location, to_location, purpose, status)
     VALUES
       ($1, $3, $4, $5, DATE '2026-08-01', 'own_car', 100, 'A', 'B', 'Kund', 'draft'),
       ($2, $3, $4, NULL, DATE '2026-08-02', 'company_car_electric', 50, 'B', 'C', 'Kund', 'draft')`,
    [tripIds[0], tripIds[1], companyId, userId, employeeId],
  )
  return { userId, companyId, employeeId, runId, runEmployeeId, tripIds }
}

function claims(fixture: PayrollFixture): MileageClaim[] {
  return [
    {
      trip_ids: [fixture.tripIds[0]],
      line_item: {
        item_type: 'mileage_taxfree',
        description: 'Own car mileage',
        quantity: 10,
        unit_price: 25,
        amount: 250,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        account_number: '7331',
        sort_order: 100,
      },
    },
    {
      trip_ids: [fixture.tripIds[1]],
      line_item: {
        item_type: 'mileage_taxfree',
        description: 'Electric company car mileage',
        quantity: 5,
        unit_price: 9.5,
        amount: 47.5,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        account_number: '7331',
        sort_order: 101,
      },
    },
  ]
}

async function submitClaims(
  fixture: PayrollFixture,
  submittedClaims: MileageClaim[],
): Promise<Record<string, unknown>> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: fixture.userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [fixture.userId])
    await client.query(`SET LOCAL ROLE authenticated`)
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.claim_mileage_trips_for_salary($1, $2, $3, $4::jsonb) AS result`,
      [
        fixture.companyId,
        fixture.runId,
        fixture.runEmployeeId,
        JSON.stringify(submittedClaims),
      ],
    )
    await client.query('COMMIT')
    return result.rows[0]!.result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function claim(fixture: PayrollFixture): Promise<Record<string, unknown>> {
  return submitClaims(fixture, claims(fixture))
}

async function expectConflictWithoutPartialClaim(
  fixture: PayrollFixture,
  submittedClaims: MileageClaim[],
): Promise<void> {
  expect(await submitClaims(fixture, submittedClaims)).toEqual({ outcome: 'conflict' })

  const state = await getPool().query<{
    lines: string
    booked: string
    provenance: string
  }>(
    `SELECT
       (SELECT count(*) FROM public.salary_line_items line
        WHERE line.salary_run_employee_id = $1) AS lines,
       (SELECT count(*) FROM public.mileage_trips trip
        WHERE trip.id = ANY($2::uuid[]) AND trip.status = 'booked') AS booked,
       (SELECT count(*) FROM public.mileage_trips trip
        WHERE trip.id = ANY($2::uuid[])
          AND (trip.salary_run_id IS NOT NULL
            OR trip.salary_line_item_id IS NOT NULL
            OR trip.journal_entry_id IS NOT NULL)) AS provenance`,
    [fixture.runEmployeeId, fixture.tripIds],
  )
  expect(state.rows[0]).toEqual({ lines: '0', booked: '0', provenance: '0' })
}

describe('M6 mileage salary claim', () => {
  it('claims exact ordered partitions and creates one compliant line per partition', async () => {
    const fixture = await seedPayrollFixture()
    expect(await claim(fixture)).toEqual({
      outcome: 'claimed',
      claimed_trip_count: 2,
      created_line_item_count: 2,
    })

    const rows = await getPool().query<{
      trip_id: string
      employee_id: string | null
      status: string
      salary_run_id: string
      salary_line_item_id: string
      journal_entry_id: string | null
      item_type: string
      account_number: string
      is_taxable: boolean
      is_avgift_basis: boolean
      is_vacation_basis: boolean
    }>(
      `SELECT trip.id::text AS trip_id, trip.employee_id::text, trip.status,
         trip.salary_run_id::text, trip.salary_line_item_id::text,
         trip.journal_entry_id::text, line.item_type, line.account_number,
         line.is_taxable, line.is_avgift_basis, line.is_vacation_basis
       FROM public.mileage_trips trip
       JOIN public.salary_line_items line ON line.id = trip.salary_line_item_id
       WHERE trip.id = ANY($1::uuid[])
       ORDER BY trip.id`,
      [fixture.tripIds],
    )
    expect(rows.rows).toHaveLength(2)
    expect(new Set(rows.rows.map((row) => row.salary_line_item_id)).size).toBe(2)
    for (const row of rows.rows) {
      expect(row).toMatchObject({
        status: 'booked',
        salary_run_id: fixture.runId,
        journal_entry_id: null,
        item_type: 'mileage_taxfree',
        account_number: '7331',
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
      })
    }
  })

  it('accepts grouped claims with every vehicle type in exactly one partition', async () => {
    const fixture = await seedPayrollFixture()
    const extraTripIds = [randomUUID(), randomUUID()]
    await getPool().query(
      `INSERT INTO public.mileage_trips
         (id, company_id, user_id, employee_id, trip_date, vehicle_type,
          distance_km, from_location, to_location, purpose, status)
       VALUES
         ($1, $3, $4, $5, DATE '2026-08-03', 'own_car', 20, 'C', 'D', 'Kund', 'draft'),
         ($2, $3, $4, NULL, DATE '2026-08-04', 'company_car_electric', 30, 'D', 'E', 'Kund', 'draft')`,
      [extraTripIds[0], extraTripIds[1], fixture.companyId, fixture.userId, fixture.employeeId],
    )
    const groupedClaims = claims(fixture)
    groupedClaims[0]!.trip_ids.push(extraTripIds[0]!)
    groupedClaims[0]!.line_item.quantity = 12
    groupedClaims[0]!.line_item.amount = 300
    groupedClaims[1]!.trip_ids.push(extraTripIds[1]!)
    groupedClaims[1]!.line_item.quantity = 8
    groupedClaims[1]!.line_item.amount = 76

    expect(await submitClaims(fixture, groupedClaims)).toEqual({
      outcome: 'claimed',
      claimed_trip_count: 4,
      created_line_item_count: 2,
    })
    const ownership = await getPool().query<{
      vehicle_type: string
      trip_count: string
      line_count: string
    }>(
      `SELECT trip.vehicle_type, count(*) AS trip_count,
         count(DISTINCT trip.salary_line_item_id) AS line_count
       FROM public.mileage_trips trip
       WHERE trip.id = ANY($1::uuid[])
       GROUP BY trip.vehicle_type
       ORDER BY trip.vehicle_type`,
      [[...fixture.tripIds, ...extraTripIds]],
    )
    expect(ownership.rows).toEqual([
      { vehicle_type: 'company_car_electric', trip_count: '2', line_count: '1' },
      { vehicle_type: 'own_car', trip_count: '2', line_count: '1' },
    ])
  })

  it('rejects line items with a missing or extra key without partial claims', async () => {
    const missingFixture = await seedPayrollFixture()
    const missingKeyClaims = claims(missingFixture)
    const missingKeyLine = { ...missingKeyClaims[0]!.line_item }
    delete (missingKeyLine as Partial<MileageLineItem>).description
    missingKeyClaims[0] = {
      ...missingKeyClaims[0]!,
      line_item: missingKeyLine as MileageLineItem,
    }
    await expectConflictWithoutPartialClaim(missingFixture, missingKeyClaims)

    const extraFixture = await seedPayrollFixture()
    const extraKeyClaims = claims(extraFixture)
    extraKeyClaims[0] = {
      ...extraKeyClaims[0]!,
      line_item: {
        ...extraKeyClaims[0]!.line_item,
        currency: 'SEK',
      },
    }
    await expectConflictWithoutPartialClaim(extraFixture, extraKeyClaims)
  })

  it.each([
    { mismatch: 'distance quantity', field: 'quantity' as const, value: 9.99 },
    { mismatch: 'annual vehicle rate', field: 'unit_price' as const, value: 24 },
    { mismatch: 'calculated amount', field: 'amount' as const, value: 249.99 },
  ])('rejects a wrong $mismatch without partial claims', async ({ field, value }) => {
    const fixture = await seedPayrollFixture()
    const mismatchedClaims = claims(fixture)
    mismatchedClaims[0]!.line_item[field] = value
    await expectConflictWithoutPartialClaim(fixture, mismatchedClaims)
  })

  it('uses application quantity rounding before amount rounding', async () => {
    const fixture = await seedPayrollFixture()
    await getPool().query(`UPDATE public.mileage_trips SET distance_km = 100.049 WHERE id = $1`, [
      fixture.tripIds[0],
    ])
    const unroundedAmountClaims = claims(fixture)
    unroundedAmountClaims[0]!.line_item.amount = 250.12
    await expectConflictWithoutPartialClaim(fixture, unroundedAmountClaims)
    expect(await submitClaims(fixture, claims(fixture))).toEqual({
      outcome: 'claimed',
      claimed_trip_count: 2,
      created_line_item_count: 2,
    })
  })

  it('rejects a claim when the salary run year has no annual mileage config', async () => {
    const fixture = await seedPayrollFixture()
    await getPool().query(`UPDATE public.salary_runs SET period_year = 2099 WHERE id = $1`, [
      fixture.runId,
    ])
    await expectConflictWithoutPartialClaim(fixture, claims(fixture))
  })

  it('rejects mixed, duplicate, and missing vehicle partitions without partial claims', async () => {
    const mixedFixture = await seedPayrollFixture()
    const mixedClaims = claims(mixedFixture)
    mixedClaims[0]!.trip_ids = [...mixedFixture.tripIds]
    mixedClaims.splice(1, 1)
    await expectConflictWithoutPartialClaim(mixedFixture, mixedClaims)

    const duplicateFixture = await seedPayrollFixture()
    await getPool().query(
      `UPDATE public.mileage_trips
       SET vehicle_type = 'own_car'
       WHERE id = $1`,
      [duplicateFixture.tripIds[1]],
    )
    const duplicateVehicleClaims = claims(duplicateFixture)
    duplicateVehicleClaims[1]!.line_item.unit_price = 25
    duplicateVehicleClaims[1]!.line_item.amount = 125
    await expectConflictWithoutPartialClaim(duplicateFixture, duplicateVehicleClaims)

    const missingFixture = await seedPayrollFixture()
    const missingPartitionClaims = claims(missingFixture)
    missingPartitionClaims[1]!.trip_ids = []
    await expectConflictWithoutPartialClaim(missingFixture, missingPartitionClaims)
  })

  it('rejects duplicate or foreign trip IDs without inserting partial salary lines', async () => {
    const fixture = await seedPayrollFixture()
    const duplicateClaims = claims(fixture)
    duplicateClaims[1] = {
      ...duplicateClaims[1],
      trip_ids: [fixture.tripIds[0]],
    }
    const result = await withUserContext(fixture.userId, async (client) => {
      const query = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.claim_mileage_trips_for_salary($1, $2, $3, $4::jsonb) AS result`,
        [fixture.companyId, fixture.runId, fixture.runEmployeeId, JSON.stringify(duplicateClaims)],
      )
      return query.rows[0]!.result
    })
    expect(result).toEqual({ outcome: 'conflict' })

    const foreign = await seedPayrollFixture()
    const foreignClaims = claims(fixture)
    foreignClaims[1] = {
      ...foreignClaims[1],
      trip_ids: [foreign.tripIds[0]],
    }
    const foreignResult = await withUserContext(fixture.userId, async (client) => {
      const query = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.claim_mileage_trips_for_salary($1, $2, $3, $4::jsonb) AS result`,
        [
          fixture.companyId,
          fixture.runId,
          fixture.runEmployeeId,
          JSON.stringify(foreignClaims),
        ],
      )
      return query.rows[0]!.result
    })
    expect(foreignResult).toEqual({ outcome: 'conflict' })

    const state = await getPool().query<{ lines: string; booked: string }>(
      `SELECT
         (SELECT count(*) FROM public.salary_line_items line
          WHERE line.salary_run_employee_id = $1) AS lines,
         (SELECT count(*) FROM public.mileage_trips trip
          WHERE trip.id = ANY($2::uuid[]) AND trip.status = 'booked') AS booked`,
      [fixture.runEmployeeId, fixture.tripIds],
    )
    expect(state.rows[0]).toEqual({ lines: '0', booked: '0' })
  })

  it('releases exact line ownership and deletes in the same transaction', async () => {
    const fixture = await seedPayrollFixture()
    await claim(fixture)
    const owned = await getPool().query<{ line_id: string; trip_id: string }>(
      `SELECT salary_line_item_id::text AS line_id, id::text AS trip_id
       FROM public.mileage_trips
       WHERE id = $1`,
      [fixture.tripIds[0]],
    )
    const lineId = owned.rows[0]!.line_id

    const client = await getClient()
    let deleted: Record<string, unknown>
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: fixture.userId, role: 'authenticated' }),
      ])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [fixture.userId])
      await client.query(`SET LOCAL ROLE authenticated`)
      const result = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.delete_draft_salary_object_with_mileage_release(
           $1, $2, 'line_item', $3
         ) AS result`,
        [fixture.companyId, fixture.runId, lineId],
      )
      deleted = result.rows[0]!.result
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    expect(deleted).toEqual({
      outcome: 'deleted',
      released_trip_count: 1,
      expected_trip_count: 1,
    })

    const released = await getPool().query<{
      status: string
      salary_run_id: string | null
      salary_line_item_id: string | null
      line_exists: string
    }>(
      `SELECT trip.status, trip.salary_run_id::text, trip.salary_line_item_id::text,
         (SELECT count(*) FROM public.salary_line_items line WHERE line.id = $2) AS line_exists
       FROM public.mileage_trips trip WHERE trip.id = $1`,
      [fixture.tripIds[0], lineId],
    )
    expect(released.rows[0]).toEqual({
      status: 'draft',
      salary_run_id: null,
      salary_line_item_id: null,
      line_exists: '0',
    })
  })

  it('blocks direct salary deletion and denies cross-tenant claims', async () => {
    const fixture = await seedPayrollFixture()
    await expect(
      getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [fixture.runId]),
    ).rejects.toMatchObject({ code: '23514' })

    const outsider = await seedCompany()
    await expect(
      withUserContext(outsider.userId, async (client) => {
        await client.query(
          `SELECT public.claim_mileage_trips_for_salary($1, $2, $3, $4::jsonb)`,
          [
            fixture.companyId,
            fixture.runId,
            fixture.runEmployeeId,
            JSON.stringify(claims(fixture)),
          ],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('enforces coherent draft and booked provenance on every direct mutation', async () => {
    const fixture = await seedPayrollFixture()

    await expect(
      getPool().query(
        `UPDATE public.mileage_trips
         SET salary_run_id = $2
         WHERE id = $1`,
        [fixture.tripIds[0], fixture.runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.mileage_trips
         SET status = 'booked'
         WHERE id = $1`,
        [fixture.tripIds[1]],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const state = await getPool().query<{
      status: string
      salary_run_id: string | null
      salary_line_item_id: string | null
      journal_entry_id: string | null
      line_count: string
    }>(
      `SELECT trip.status, trip.salary_run_id::text, trip.salary_line_item_id::text,
         trip.journal_entry_id::text,
         (SELECT count(*) FROM public.salary_line_items line
          WHERE line.salary_run_employee_id = $2) AS line_count
       FROM public.mileage_trips trip
       WHERE trip.id = ANY($1::uuid[])
       ORDER BY trip.id`,
      [fixture.tripIds, fixture.runEmployeeId],
    )
    expect(state.rows).toHaveLength(2)
    for (const row of state.rows) {
      expect(row).toEqual({
        status: 'draft',
        salary_run_id: null,
        salary_line_item_id: null,
        journal_entry_id: null,
        line_count: '0',
      })
    }
  })

  it('ignores forged accounted mileage and deletion GUCs for direct writes', async () => {
    const mutationFixture = await seedPayrollFixture()
    const forgedLineId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_line_items
         (id, salary_run_employee_id, company_id, item_type, description,
          quantity, unit_price, amount, is_taxable, is_avgift_basis,
          is_vacation_basis, account_number, sort_order)
       VALUES ($1, $2, $3, 'mileage_taxfree', 'Forged mileage',
         10, 25, 250, false, false, false, '7331', 100)`,
      [forgedLineId, mutationFixture.runEmployeeId, mutationFixture.companyId],
    )
    await expect(
      withUserContext(mutationFixture.userId, async (client) => {
        await client.query(
          `SELECT
             set_config('accounted.mileage_salary_claim', '1', true),
             set_config('accounted.salary_mileage_delete', '1', true)`,
        )
        await client.query(
          `UPDATE public.mileage_trips
           SET status = 'booked',
               salary_run_id = $2,
               salary_line_item_id = $3
           WHERE id = $1`,
          [mutationFixture.tripIds[0], mutationFixture.runId, forgedLineId],
        )
      }),
    ).rejects.toMatchObject({ code: '23514' })
    const mutationState = await getPool().query<{
      status: string
      salary_run_id: string | null
      salary_line_item_id: string | null
    }>(
      `SELECT status, salary_run_id::text, salary_line_item_id::text
       FROM public.mileage_trips
       WHERE id = $1`,
      [mutationFixture.tripIds[0]],
    )
    expect(mutationState.rows[0]).toEqual({
      status: 'draft',
      salary_run_id: null,
      salary_line_item_id: null,
    })

    const deletionFixture = await seedPayrollFixture()
    await claim(deletionFixture)
    const claimedLine = await getPool().query<{ line_id: string }>(
      `SELECT salary_line_item_id::text AS line_id
       FROM public.mileage_trips
       WHERE id = $1`,
      [deletionFixture.tripIds[0]],
    )
    await expect(
      withUserContext(deletionFixture.userId, async (client) => {
        await client.query(
          `SELECT
             set_config('accounted.mileage_salary_claim', '1', true),
             set_config('accounted.salary_mileage_delete', '1', true)`,
        )
        await client.query(`DELETE FROM public.salary_line_items WHERE id = $1`, [
          claimedLine.rows[0]!.line_id,
        ])
      }),
    ).rejects.toMatchObject({ code: '23514' })
    const deletionState = await getPool().query<{ lines: string; booked: string }>(
      `SELECT
         (SELECT count(*) FROM public.salary_line_items line
          WHERE line.salary_run_employee_id = $1) AS lines,
         (SELECT count(*) FROM public.mileage_trips trip
          WHERE trip.id = ANY($2::uuid[]) AND trip.status = 'booked') AS booked`,
      [deletionFixture.runEmployeeId, deletionFixture.tripIds],
    )
    expect(deletionState.rows[0]).toEqual({ lines: '2', booked: '2' })
  })

  it('uses safe definer functions and least-privilege grants', async () => {
    const rows = await getPool().query<{
      name: string
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
      security_definer: boolean
      config: string[] | null
    }>(
      `SELECT p.proname AS name,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         p.prosecdef AS security_definer,
         p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'claim_mileage_trips_for_salary',
           'delete_draft_salary_object_with_mileage_release',
           'guard_salary_mileage_claim_delete'
         )
       ORDER BY p.proname`,
    )
    const byName = Object.fromEntries(rows.rows.map((row) => [row.name, row]))
    for (const rpc of [
      'claim_mileage_trips_for_salary',
      'delete_draft_salary_object_with_mileage_release',
    ]) {
      expect(byName[rpc]).toMatchObject({
        authenticated_exec: true,
        service_exec: true,
        public_exec: false,
        security_definer: true,
      })
      expect(byName[rpc].config).toContain('search_path=pg_catalog, public')
    }
    expect(byName.guard_salary_mileage_claim_delete).toMatchObject({
      authenticated_exec: false,
      service_exec: false,
      public_exec: false,
    })
  })
})
