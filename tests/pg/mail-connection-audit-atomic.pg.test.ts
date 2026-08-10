import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

const UPSERT_SQL = `
  SELECT public.upsert_mail_connection_with_audit(
    $1, $2, 'gmail', $3, $4, $5, $6, ARRAY['gmail.readonly']::text[], NULL
  ) AS id
`

async function upsert(
  client: PoolClient,
  companyId: string,
  userId: string,
  email = 'owner@example.com',
  refresh = 'encrypted-refresh-v1',
) {
  return client.query<{ id: string }>(UPSERT_SQL, [
    companyId,
    userId,
    email,
    refresh,
    'encrypted-access-v1',
    '2026-08-10T14:00:00Z',
  ])
}

describe('atomic mail connection credential audit RPCs (pg)', () => {
  it('audits connect, reconnect, backfill update, and disconnect without credential material', async () => {
    const { companyId, userId } = await seedCompany()

    const connectionId = await runAsServiceRole(async (client) => {
      const first = await upsert(client, companyId, userId)
      const id = first.rows[0].id
      const second = await upsert(
        client,
        companyId,
        userId,
        'OWNER@example.com',
        'encrypted-refresh-v2',
      )
      expect(second.rows[0].id).toBe(id)

      await client.query(
        `SELECT public.update_mail_connection_backfill_with_audit($1, $2, $3, $4)`,
        [companyId, id, userId, '2026-05-12'],
      )
      await client.query(
        `SELECT public.disconnect_mail_connection_with_audit($1, $2, $3)`,
        [companyId, id, userId],
      )
      return id
    })

    const { rows: connections } = await getPool().query(
      `SELECT id FROM public.mail_connections WHERE id = $1`,
      [connectionId],
    )
    expect(connections).toHaveLength(0)

    const { rows: auditRows } = await getPool().query<{
      action: string
      old_state: unknown
      new_state: unknown
      description: string
    }>(
      `SELECT action, old_state, new_state, description
       FROM public.audit_log
       WHERE company_id = $1
         AND table_name = 'mail_connections'
         AND record_id = $2
       ORDER BY created_at, id`,
      [companyId, connectionId],
    )
    expect(auditRows.map((row) => row.action).sort()).toEqual([
      'DELETE',
      'INSERT',
      'UPDATE',
      'UPDATE',
    ])
    const auditText = JSON.stringify(auditRows)
    expect(auditText).not.toContain('encrypted-refresh')
    expect(auditText).not.toContain('encrypted-access')
    expect(auditText).not.toContain('encrypted_refresh_token')
    expect(auditText).not.toContain('encrypted_access_token')
  })

  it('refuses service-role requests naming a viewer or another company member', async () => {
    const viewer = await seedCompany()
    const other = await seedCompany()
    await getPool().query(
      `UPDATE public.company_members SET role = 'viewer'
       WHERE company_id = $1 AND user_id = $2`,
      [viewer.companyId, viewer.userId],
    )

    await expect(runAsServiceRole((client) => upsert(client, viewer.companyId, viewer.userId)))
      .rejects.toThrow(/Writable company membership required/)
    await expect(runAsServiceRole((client) => upsert(client, other.companyId, viewer.userId)))
      .rejects.toThrow(/Writable company membership required/)
  })

  it('cannot be invoked directly by an authenticated member', async () => {
    const { companyId, userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await expect(upsert(client, companyId, userId)).rejects.toThrow(/permission denied/i)
    })
  })

  it('rolls the credential insert back when the audit insert fails', async () => {
    const { companyId, userId } = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE FUNCTION pg_temp.reject_mail_connection_audit()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.table_name = 'mail_connections' THEN
            RAISE EXCEPTION 'forced audit failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `)
      await client.query(`
        CREATE TRIGGER test_reject_mail_connection_audit
        BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_mail_connection_audit()
      `)
      await client.query('SAVEPOINT before_rpc')
      await client.query(
        `SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`,
      )
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'service_role', true)`,
      )
      await client.query('SET LOCAL ROLE service_role')

      await expect(upsert(client, companyId, userId)).rejects.toThrow(/forced audit failure/)
      await client.query('ROLLBACK TO SAVEPOINT before_rpc')

      const { rows } = await client.query(
        `SELECT id FROM public.mail_connections
         WHERE company_id = $1 AND email_address = 'owner@example.com'`,
        [companyId],
      )
      expect(rows).toHaveLength(0)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('pins search_path and grants execution only to service_role', async () => {
    const signatures = [
      'public.upsert_mail_connection_with_audit(uuid,uuid,text,text,text,text,timestamptz,text[],date)',
      'public.update_mail_connection_backfill_with_audit(uuid,uuid,uuid,date)',
      'public.disconnect_mail_connection_with_audit(uuid,uuid,uuid)',
    ]

    for (const signature of signatures) {
      const { rows } = await getPool().query<{
        security_definer: boolean
        config: string[] | null
        anon_exec: boolean
        authenticated_exec: boolean
        service_exec: boolean
      }>(
        `SELECT p.prosecdef AS security_definer,
                p.proconfig AS config,
                has_function_privilege('anon', $1, 'EXECUTE') AS anon_exec,
                has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated_exec,
                has_function_privilege('service_role', $1, 'EXECUTE') AS service_exec
         FROM pg_proc p
         WHERE p.oid = $1::regprocedure`,
        [signature],
      )
      expect(rows[0].security_definer).toBe(true)
      expect(rows[0].config ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/^search_path=(?:""|)$/)]),
      )
      expect(rows[0].anon_exec).toBe(false)
      expect(rows[0].authenticated_exec).toBe(false)
      expect(rows[0].service_exec).toBe(true)
    }
  })
})
