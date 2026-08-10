import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompanyMember,
  seedCompany,
} from './fixtures'
import { getPool, withUserContext } from './setup'

// All authorization assertions execute through withUserContext(), which sets
// JWT claims and SET LOCAL ROLE authenticated. The pool is used only to seed
// and inspect fixtures as the superuser.
//
// PostgreSQL emits 42501 for failed INSERT/WITH CHECK predicates. UPDATE and
// DELETE rows rejected by USING are intentionally invisible and therefore
// return zero affected rows instead of raising; those cases assert rowCount
// and then verify that the seeded row is unchanged.

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function expectRlsViolation(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: '42501' })
}

type ConnectionTable = 'shopify_connections' | 'woocommerce_connections'

const connectionTables: Array<{
  table: ConnectionTable
  locationColumn: 'shop_domain' | 'store_url'
  location: (label: string) => string
}> = [
  {
    table: 'shopify_connections',
    locationColumn: 'shop_domain',
    location: (label) => `${label}-${randomUUID()}.myshopify.com`,
  },
  {
    table: 'woocommerce_connections',
    locationColumn: 'store_url',
    location: (label) => `https://${label}-${randomUUID()}.example.se`,
  },
]

async function insertConnection(
  client: PoolClient,
  config: (typeof connectionTables)[number],
  companyId: string,
  userId: string,
  label: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.${config.table}
       (company_id, user_id, ${config.locationColumn}, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id`,
    [companyId, userId, config.location(label)],
  )
  return result.rows[0].id
}

describe.each(connectionTables)('$table writable-role RLS', (config) => {
  it('denies viewer insert with 42501 and filters viewer updates', async () => {
    const company = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: viewerId,
      role: 'viewer',
    })
    await setActiveCompany(viewerId, company.companyId)

    await expectRlsViolation(
      withUserContext(viewerId, (client) =>
        insertConnection(
          client,
          config,
          company.companyId,
          viewerId,
          'viewer-insert',
        ),
      ),
    )

    const seeded = await getPool().query<{ id: string }>(
      `INSERT INTO public.${config.table}
         (company_id, user_id, ${config.locationColumn}, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [
        company.companyId,
        company.userId,
        config.location('viewer-update'),
      ],
    )
    const connectionId = seeded.rows[0].id

    const updated = await withUserContext(viewerId, (client) =>
      client.query(
        `UPDATE public.${config.table}
            SET status = 'error'
          WHERE id = $1
          RETURNING id`,
        [connectionId],
      ),
    )
    expect(updated.rowCount).toBe(0)

    const unchanged = await getPool().query<{ status: string }>(
      `SELECT status FROM public.${config.table} WHERE id = $1`,
      [connectionId],
    )
    expect(unchanged.rows[0].status).toBe('pending')
  })

  it('allows a writable member to insert and update', async () => {
    const company = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: memberId,
      role: 'member',
    })
    await setActiveCompany(memberId, company.companyId)

    await withUserContext(memberId, async (client) => {
      const id = await insertConnection(
        client,
        config,
        company.companyId,
        memberId,
        'member',
      )
      const updated = await client.query(
        `UPDATE public.${config.table}
            SET status = 'error'
          WHERE id = $1
          RETURNING id`,
        [id],
      )
      expect(updated.rows).toEqual([{ id }])
    })
  })

  it('rejects foreign-company inserts and tenant row moves with 42501', async () => {
    const companyA = await seedCompany()
    const companyB = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: companyA.companyId,
      userId: memberId,
      role: 'member',
    })
    await insertCompanyMember({
      companyId: companyB.companyId,
      userId: memberId,
      role: 'member',
    })
    await setActiveCompany(memberId, companyA.companyId)

    await expectRlsViolation(
      withUserContext(memberId, (client) =>
        insertConnection(
          client,
          config,
          companyB.companyId,
          memberId,
          'foreign',
        ),
      ),
    )

    const seeded = await getPool().query<{ id: string }>(
      `INSERT INTO public.${config.table}
         (company_id, user_id, ${config.locationColumn}, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [companyA.companyId, memberId, config.location('row-move')],
    )
    await expectRlsViolation(
      withUserContext(memberId, (client) =>
        client.query(
          `UPDATE public.${config.table}
              SET company_id = $2
            WHERE id = $1`,
          [seeded.rows[0].id, companyB.companyId],
        ),
      ),
    )
  })
})

async function insertMileageTrip(
  client: PoolClient,
  companyId: string,
  userId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO public.mileage_trips
       (company_id, user_id, trip_date, distance_km, from_location,
        to_location, purpose)
     VALUES ($1, $2, '2026-08-09', 12.5, 'A', 'B', 'Kundbesök')
     RETURNING id`,
    [companyId, userId],
  )
  return result.rows[0].id
}

describe('mileage_trips writable-role RLS', () => {
  it('denies viewer insert with 42501 and filters viewer update and delete', async () => {
    const company = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: viewerId,
      role: 'viewer',
    })
    await setActiveCompany(viewerId, company.companyId)

    await expectRlsViolation(
      withUserContext(viewerId, (client) =>
        insertMileageTrip(client, company.companyId, viewerId),
      ),
    )

    const seeded = await getPool().query<{ id: string }>(
      `INSERT INTO public.mileage_trips
         (company_id, user_id, trip_date, distance_km, from_location,
          to_location, purpose)
       VALUES ($1, $2, '2026-08-09', 12.5, 'A', 'B', 'Kundbesök')
       RETURNING id`,
      [company.companyId, company.userId],
    )
    const tripId = seeded.rows[0].id
    const updated = await withUserContext(viewerId, (client) =>
      client.query(
        `UPDATE public.mileage_trips SET notes = 'blocked' WHERE id = $1 RETURNING id`,
        [tripId],
      ),
    )
    expect(updated.rowCount).toBe(0)

    const deleted = await withUserContext(viewerId, (client) =>
      client.query(
        `DELETE FROM public.mileage_trips WHERE id = $1 RETURNING id`,
        [tripId],
      ),
    )
    expect(deleted.rowCount).toBe(0)

    const unchanged = await getPool().query<{ notes: string | null }>(
      `SELECT notes FROM public.mileage_trips WHERE id = $1`,
      [tripId],
    )
    expect(unchanged.rows).toEqual([{ notes: null }])
  })

  it('allows a writable member to insert, update, and delete a draft', async () => {
    const company = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: company.companyId,
      userId: memberId,
      role: 'member',
    })
    await setActiveCompany(memberId, company.companyId)

    await withUserContext(memberId, async (client) => {
      const id = await insertMileageTrip(client, company.companyId, memberId)
      const updated = await client.query(
        `UPDATE public.mileage_trips SET notes = 'allowed' WHERE id = $1 RETURNING id`,
        [id],
      )
      expect(updated.rows).toEqual([{ id }])

      const deleted = await client.query(
        `DELETE FROM public.mileage_trips WHERE id = $1 RETURNING id`,
        [id],
      )
      expect(deleted.rows).toEqual([{ id }])
    })
  })

  it('rejects foreign-company inserts and tenant row moves with 42501', async () => {
    const companyA = await seedCompany()
    const companyB = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({
      companyId: companyA.companyId,
      userId: memberId,
      role: 'member',
    })
    await insertCompanyMember({
      companyId: companyB.companyId,
      userId: memberId,
      role: 'member',
    })
    await setActiveCompany(memberId, companyA.companyId)

    await expectRlsViolation(
      withUserContext(memberId, (client) =>
        insertMileageTrip(client, companyB.companyId, memberId),
      ),
    )

    const seeded = await getPool().query<{ id: string }>(
      `INSERT INTO public.mileage_trips
         (company_id, user_id, trip_date, distance_km, from_location,
          to_location, purpose)
       VALUES ($1, $2, '2026-08-09', 12.5, 'A', 'B', 'Kundbesök')
       RETURNING id`,
      [companyA.companyId, memberId],
    )
    await expectRlsViolation(
      withUserContext(memberId, (client) =>
        client.query(
          `UPDATE public.mileage_trips SET company_id = $2 WHERE id = $1`,
          [seeded.rows[0].id, companyB.companyId],
        ),
      ),
    )
  })
})
