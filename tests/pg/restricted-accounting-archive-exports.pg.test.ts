import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'

const TABLES = [
  'supplier_payment_reversals',
  'transaction_categorization_compensations',
  'accounting_publications',
  'accounting_publication_subscribers',
] as const

const FUNCTIONS = [
  'export_supplier_payment_reversals',
  'export_transaction_categorization_compensations',
  'export_accounting_publications',
  'export_accounting_publication_subscribers',
] as const

describe('restricted accounting archive exports', () => {
  it('keeps direct table SELECT revoked and grants only service-role RPC execution', async () => {
    const { rows: tablePrivileges } = await getPool().query<{
      table_name: string
      anon_select: boolean
      authenticated_select: boolean
      service_select: boolean
    }>(`
      SELECT table_name,
             has_table_privilege('anon', 'public.' || table_name, 'SELECT') AS anon_select,
             has_table_privilege('authenticated', 'public.' || table_name, 'SELECT') AS authenticated_select,
             has_table_privilege('service_role', 'public.' || table_name, 'SELECT') AS service_select
      FROM unnest($1::text[]) AS restricted(table_name)
      ORDER BY table_name
    `, [TABLES])

    expect(tablePrivileges).toHaveLength(TABLES.length)
    for (const privilege of tablePrivileges) {
      expect(privilege.anon_select, privilege.table_name).toBe(false)
      expect(privilege.authenticated_select, privilege.table_name).toBe(false)
      expect(privilege.service_select, privilege.table_name).toBe(false)
    }

    const { rows: functionPrivileges } = await getPool().query<{
      function_name: string
      security_definer: boolean
      volatility: string
      search_path: string[] | null
      public_execute: boolean
      anon_execute: boolean
      authenticated_execute: boolean
      service_execute: boolean
    }>(`
      SELECT procedure.proname AS function_name,
             procedure.prosecdef AS security_definer,
             procedure.provolatile AS volatility,
             procedure.proconfig AS search_path,
             EXISTS (
               SELECT 1
               FROM aclexplode(COALESCE(
                 procedure.proacl,
                 acldefault('f', procedure.proowner)
               )) privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_execute,
             has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
             has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS authenticated_execute,
             has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY($1::text[])
      ORDER BY procedure.proname
    `, [FUNCTIONS])

    expect(functionPrivileges).toHaveLength(FUNCTIONS.length)
    for (const privilege of functionPrivileges) {
      expect(privilege.security_definer, privilege.function_name).toBe(true)
      expect(privilege.volatility, privilege.function_name).toBe('s')
      expect(privilege.search_path, privilege.function_name).toContain('search_path=pg_catalog, public')
      expect(privilege.public_execute, privilege.function_name).toBe(false)
      expect(privilege.anon_execute, privilege.function_name).toBe(false)
      expect(privilege.authenticated_execute, privilege.function_name).toBe(false)
      expect(privilege.service_execute, privilege.function_name).toBe(true)
    }
  })

  it('returns only the requested company through the service boundary', async () => {
    const first = await seedCompany()
    const second = await seedCompany()
    const firstPublicationId = randomUUID()
    const secondPublicationId = randomUUID()
    const firstSubscriberId = randomUUID()
    const secondSubscriberId = randomUUID()

    await getPool().query(
      `INSERT INTO public.accounting_publications
         (id, company_id, publication_key, event_type, user_id, payload)
       VALUES ($1, $2, 'archive:first', 'journal_entry.committed', $3, '{}'::jsonb),
              ($4, $5, 'archive:second', 'journal_entry.committed', $6, '{}'::jsonb)`,
      [
        firstPublicationId,
        first.companyId,
        first.userId,
        secondPublicationId,
        second.companyId,
        second.userId,
      ],
    )
    await getPool().query(
      `INSERT INTO public.accounting_publication_subscribers
         (id, publication_id, company_id, webhook_id, api_version)
       VALUES ($1, $2, $3, $4, 'v1'),
              ($5, $6, $7, $8, 'v1')`,
      [
        firstSubscriberId,
        firstPublicationId,
        first.companyId,
        randomUUID(),
        secondSubscriberId,
        secondPublicationId,
        second.companyId,
        randomUUID(),
      ],
    )

    const exported = await runAsServiceRole(async (client) => {
      const publications = await client.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM public.export_accounting_publications($1)`,
        [first.companyId],
      )
      const subscribers = await client.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM public.export_accounting_publication_subscribers($1)`,
        [first.companyId],
      )
      const supplierReversals = await client.query(
        `SELECT id FROM public.export_supplier_payment_reversals($1)`,
        [first.companyId],
      )
      const categorizationCompensations = await client.query(
        `SELECT id FROM public.export_transaction_categorization_compensations($1)`,
        [first.companyId],
      )
      return {
        publications: publications.rows,
        subscribers: subscribers.rows,
        supplierReversals: supplierReversals.rows,
        categorizationCompensations: categorizationCompensations.rows,
      }
    })

    expect(exported.publications).toEqual([
      { id: firstPublicationId, company_id: first.companyId },
    ])
    expect(exported.subscribers).toEqual([
      { id: firstSubscriberId, company_id: first.companyId },
    ])
    expect(exported.supplierReversals).toEqual([])
    expect(exported.categorizationCompensations).toEqual([])
  })
})
