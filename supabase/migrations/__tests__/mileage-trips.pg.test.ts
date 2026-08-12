import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Locks in the mileage_trips migration (20260807084705):
 *
 *  - RLS scopes rows to the user's companies via user_company_ids();
 *  - a booked trip can never be deleted (körjournal is underlag, BFL 7-year
 *    retention: block_booked_mileage_trip_deletion trigger);
 *  - a draft trip can be deleted;
 *  - the odometer CHECK rejects an arrival reading at or below the start.
 */

async function insertTrip(params: {
  companyId: string
  userId: string
  employeeId?: string | null
  status?: 'draft' | 'booked'
  odometerStart?: number | null
  odometerEnd?: number | null
}): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.mileage_trips
       (company_id, user_id, employee_id, trip_date, distance_km, from_location,
        to_location, purpose, status, odometer_start, odometer_end)
     VALUES ($1, $2, $3, '2026-05-10', 32.3, 'Kontoret', 'Kunden', 'Kundbesök',
             $4, $5, $6)
     RETURNING id`,
    [
      params.companyId,
      params.userId,
      params.employeeId ?? null,
      params.status ?? 'draft',
      params.odometerStart ?? null,
      params.odometerEnd ?? null,
    ],
  )
  return res.rows[0].id
}

async function seedDraftSalaryClaim() {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Mila', 'Testsson', 'enc-payload', '1234', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  const run = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_runs
       (company_id, user_id, period_year, period_month, payment_date)
     VALUES ($1, $2, 2026, 5, '2026-05-25') RETURNING id`,
    [companyId, userId],
  )
  const runId = run.rows[0].id
  const sre = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree,
        monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 0, 'monthly') RETURNING id`,
    [runId, employeeId, companyId],
  )
  const tripId = await insertTrip({ companyId, userId, employeeId })
  return { userId, companyId, employeeId, runId, sreId: sre.rows[0].id, tripId }
}

describe('mileage_trips RLS', () => {
  it('shows a member their company trips and hides other companies', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertTrip({ companyId: a.companyId, userId: a.userId })
    await insertTrip({ companyId: b.companyId, userId: b.userId })

    const visibleToA = await withUserContext(a.userId, async (client) => {
      const res = await client.query(`SELECT company_id FROM public.mileage_trips`)
      return res.rows
    })
    expect(visibleToA).toHaveLength(1)
    expect(visibleToA[0].company_id).toBe(a.companyId)
  })

  it('blocks inserting a trip into a foreign company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await expect(
      withUserContext(a.userId, (client) =>
        client.query(
          `INSERT INTO public.mileage_trips
             (company_id, user_id, trip_date, distance_km, from_location, to_location, purpose)
           VALUES ($1, $2, '2026-05-10', 10, 'A', 'B', 'Test')`,
          [b.companyId, a.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })
})

describe('mileage_trips retention trigger', () => {
  it('blocks deleting a booked trip (BFL underlag)', async () => {
    const { companyId, userId } = await seedCompany()
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    await expect(
      getPool().query(`DELETE FROM public.mileage_trips WHERE id = $1`, [tripId]),
    ).rejects.toThrow(/booked mileage trip/)
  })

  it('allows deleting a draft trip', async () => {
    const { companyId, userId } = await seedCompany()
    const tripId = await insertTrip({ companyId, userId, status: 'draft' })
    const res = await getPool().query(
      `DELETE FROM public.mileage_trips WHERE id = $1`,
      [tripId],
    )
    expect(res.rowCount).toBe(1)
  })
})

describe('mileage_trips booked immutability (20260807113215)', () => {
  it('blocks changing core fields on a booked trip', async () => {
    const { companyId, userId } = await seedCompany()
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    await expect(
      getPool().query(`UPDATE public.mileage_trips SET distance_km = 999 WHERE id = $1`, [tripId]),
    ).rejects.toThrow(/booked mileage trip/)
  })

  it('allows a notes-only edit on a booked trip', async () => {
    const { companyId, userId } = await seedCompany()
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    const res = await getPool().query(
      `UPDATE public.mileage_trips SET notes = 'anteckning' WHERE id = $1`,
      [tripId],
    )
    expect(res.rowCount).toBe(1)
  })

  it('allows reverting an UNLINKED claim back to draft', async () => {
    const { companyId, userId } = await seedCompany()
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    const res = await getPool().query(
      `UPDATE public.mileage_trips SET status = 'draft' WHERE id = $1`,
      [tripId],
    )
    expect(res.rowCount).toBe(1)
  })

  it('forces a revert to draft to clear salary_run_id (20260807114924)', async () => {
    const { companyId, userId } = await seedCompany()
    const runRes = await getPool().query<{ id: string }>(
      `INSERT INTO public.salary_runs (company_id, user_id, period_year, period_month, payment_date)
       VALUES ($1, $2, 2026, 5, '2026-05-25') RETURNING id`,
      [companyId, userId],
    )
    const runId = runRes.rows[0].id
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    await getPool().query(
      `UPDATE public.mileage_trips SET salary_run_id = $2 WHERE id = $1`,
      [tripId, runId],
    )
    // Revert keeping salary_run_id: rejected (draft trip would still carry a
    // run that holds its allowance = re-bookable double pay).
    await expect(
      getPool().query(`UPDATE public.mileage_trips SET status = 'draft' WHERE id = $1`, [tripId]),
    ).rejects.toThrow(/clear salary_run_id/)
    // Revert clearing it in the same statement: allowed.
    const res = await getPool().query(
      `UPDATE public.mileage_trips SET status = 'draft', salary_run_id = NULL WHERE id = $1`,
      [tripId],
    )
    expect(res.rowCount).toBe(1)
  })

  it('blocks unbooking a trip linked to a verifikat', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertPostedJournalEntry({ companyId, userId, fiscalPeriodId })
    const tripId = await insertTrip({ companyId, userId, status: 'booked' })
    await getPool().query(
      `UPDATE public.mileage_trips SET journal_entry_id = $2 WHERE id = $1`,
      [tripId, entryId],
    )
    await expect(
      getPool().query(`UPDATE public.mileage_trips SET status = 'draft' WHERE id = $1`, [tripId]),
    ).rejects.toThrow(/linked to a verifikat/)
  })
})

describe('mileage salary-claim lifecycle (20260812090000)', () => {
  async function claim(seed: Awaited<ReturnType<typeof seedDraftSalaryClaim>>) {
    await withUserContext(
      seed.userId,
      (client) =>
        client.query(
          `SELECT public.claim_mileage_trips_for_salary_run(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid[], $5::jsonb
           )`,
          [
            seed.companyId,
            seed.runId,
            seed.employeeId,
            [seed.tripId],
            JSON.stringify([
              {
                description: 'Milersättning egen bil',
                quantity: 3.23,
                unit_price: 25,
                amount: 80.75,
                sort_order: 300,
                trip_ids: [seed.tripId],
              },
            ]),
          ],
        ),
      { commit: true },
    )
  }

  it('releases exact claims atomically for line and employee deletion', async () => {
    for (const kind of ['line', 'employee'] as const) {
      const seed = await seedDraftSalaryClaim()
      await claim(seed)

      const claimed = await getPool().query<{
        status: string
        salary_line_item_id: string | null
      }>(
        `SELECT status, salary_line_item_id
         FROM public.mileage_trips WHERE id = $1`,
        [seed.tripId],
      )
      const lineId = claimed.rows[0].salary_line_item_id
      expect(claimed.rows[0].status).toBe('booked')
      expect(lineId).toBeTruthy()

      await expect(
        getPool().query(`DELETE FROM public.salary_line_items WHERE id = $1`, [lineId]),
      ).rejects.toThrow()

      const targetId = kind === 'line' ? lineId : seed.sreId
      await withUserContext(
        seed.userId,
        async (client) => {
          const deleted = await client.query<{ deleted: boolean }>(
            `SELECT public.delete_salary_draft_object_with_mileage_release(
               $1::uuid, $2::uuid, $3::text, $4::uuid
             ) AS deleted`,
            [seed.companyId, seed.runId, kind, targetId],
          )
          expect(deleted.rows[0].deleted).toBe(true)
        },
        { commit: true },
      )

      const released = await getPool().query<{
        status: string
        salary_run_id: string | null
        salary_line_item_id: string | null
      }>(
        `SELECT status, salary_run_id, salary_line_item_id
         FROM public.mileage_trips WHERE id = $1`,
        [seed.tripId],
      )
      expect(released.rows[0]).toEqual({
        status: 'draft',
        salary_run_id: null,
        salary_line_item_id: null,
      })
    }
  })

  it('blocks ambiguous legacy partial deletion and lets whole-run deletion release it', async () => {
    const seed = await seedDraftSalaryClaim()
    await getPool().query(
      `UPDATE public.mileage_trips
       SET status = 'booked', salary_run_id = $2
       WHERE id = $1`,
      [seed.tripId, seed.runId],
    )

    await expect(
      getPool().query(`DELETE FROM public.salary_run_employees WHERE id = $1`, [seed.sreId]),
    ).rejects.toThrow(/atomic mileage-release command/)

    await withUserContext(
      seed.userId,
      async (client) => {
        const deleted = await client.query<{ deleted: boolean }>(
          `SELECT public.delete_salary_draft_object_with_mileage_release(
             $1::uuid, $2::uuid, 'run', $2::uuid
           ) AS deleted`,
          [seed.companyId, seed.runId],
        )
        expect(deleted.rows[0].deleted).toBe(true)
      },
      { commit: true },
    )

    const released = await getPool().query<{
      status: string
      salary_run_id: string | null
      salary_line_item_id: string | null
    }>(
      `SELECT status, salary_run_id, salary_line_item_id
       FROM public.mileage_trips WHERE id = $1`,
      [seed.tripId],
    )
    expect(released.rows[0]).toEqual({
      status: 'draft',
      salary_run_id: null,
      salary_line_item_id: null,
    })
  })
})

describe('mileage_trips constraints', () => {
  it('rejects an arrival odometer at or below the start reading', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(
      insertTrip({ companyId, userId, odometerStart: 1032, odometerEnd: 1000 }),
    ).rejects.toThrow(/mileage_trips_odometer_order/)
  })

  it('accepts a plain km distance without odometer readings', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertTrip({ companyId, userId })
    expect(id).toBeTruthy()
  })
})
