import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

const MAX_CORRECTION_DEPTH = 32
const TERMINAL_STORNO_DEPTH = 33

interface TenantFixture {
  userId: string
  companyId: string
  fiscalPeriodId: string
}

interface LineageEntryInput extends TenantFixture {
  id?: string
  sourceType?: string
  correctionOfId?: string | null
  reversesId?: string | null
  reversedById?: string | null
  status?: 'posted' | 'reversed'
  entryDate?: string
}

async function insertLineageEntry(
  client: PoolClient,
  input: LineageEntryInput,
): Promise<string> {
  const id = input.id ?? randomUUID()
  await client.query(
    `INSERT INTO public.journal_entries (
       id,
       user_id,
       company_id,
       fiscal_period_id,
       voucher_number,
       voucher_series,
       entry_date,
       description,
       source_type,
       status,
       correction_of_id,
       reverses_id,
       reversed_by_id,
       committed_at
     ) VALUES (
       $1, $2, $3, $4, 0, 'A', $5, 'P1 lineage fixture', $6, $7,
       $8, $9, $10, '2026-06-01T10:00:00Z'
     )`,
    [
      id,
      input.userId,
      input.companyId,
      input.fiscalPeriodId,
      input.entryDate ?? '2026-06-01',
      input.sourceType ?? 'manual',
      input.status ?? 'posted',
      input.correctionOfId ?? null,
      input.reversesId ?? null,
      input.reversedById ?? null,
    ],
  )
  await client.query(
    `INSERT INTO public.journal_entry_lines (
       journal_entry_id,
       account_number,
       debit_amount,
       credit_amount,
       sort_order
     ) VALUES
       ($1, '1930', 100, 0, 0),
       ($1, '3001', 0, 100, 1)`,
    [id],
  )
  return id
}

async function markReversed(
  client: PoolClient,
  entryId: string,
  stornoId: string,
): Promise<void> {
  await client.query(
    `UPDATE public.journal_entries
     SET status = 'reversed', reversed_by_id = $2
     WHERE id = $1`,
    [entryId, stornoId],
  )
}

async function seedMaximumLineage(
  client: PoolClient,
  tenant: TenantFixture,
): Promise<{
  rootId: string
  correctionIds: string[]
  stornoIds: string[]
  terminalId: string
}> {
  const rootId = await insertLineageEntry(client, tenant)
  const correctionIds: string[] = []
  const stornoIds: string[] = []
  let currentId = rootId

  for (let depth = 1; depth <= MAX_CORRECTION_DEPTH; depth += 1) {
    const stornoId = await insertLineageEntry(client, {
      ...tenant,
      sourceType: 'storno',
      reversesId: currentId,
    })
    const correctionId = await insertLineageEntry(client, {
      ...tenant,
      sourceType: 'correction',
      correctionOfId: currentId,
    })
    await markReversed(client, currentId, stornoId)
    stornoIds.push(stornoId)
    correctionIds.push(correctionId)
    currentId = correctionId
  }

  const terminalId = await insertLineageEntry(client, {
    ...tenant,
    sourceType: 'storno',
    reversesId: currentId,
  })
  await markReversed(client, currentId, terminalId)
  stornoIds.push(terminalId)

  return { rootId, correctionIds, stornoIds, terminalId }
}

async function insertWebhook(
  client: PoolClient,
  companyId: string,
  eventType: string,
): Promise<string> {
  const webhookId = randomUUID()
  await client.query(
    `INSERT INTO public.webhooks (
       id,
       company_id,
       name,
       event_type,
       webhook_url,
       secret,
       active,
       api_version_pinned
     ) VALUES ($1, $2, 'P1 subscriber', $3, $4, $5, true, '2026-05-12')`,
    [
      webhookId,
      companyId,
      eventType,
      `https://example.invalid/hooks/${webhookId}`,
      `secret-${webhookId}`,
    ],
  )
  return webhookId
}

async function recordPublication(
  client: PoolClient,
  input: {
    companyId: string
    publicationKey: string
    eventType: string
    entityId: string
    userId: string
    payload: Record<string, unknown>
  },
): Promise<Record<string, unknown>> {
  const result = await client.query<{ result: Record<string, unknown> }>(
    `SELECT public.record_accounting_publication(
       $1, $2, $3, $4, $5, $6::jsonb
     ) AS result`,
    [
      input.companyId,
      input.publicationKey,
      input.eventType,
      input.entityId,
      input.userId,
      JSON.stringify(input.payload),
    ],
  )
  return result.rows[0]!.result
}

async function readJournalEntryEventObject(
  client: PoolClient,
  companyId: string,
  entryId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ entry: Record<string, unknown> }>(
    `SELECT
       to_jsonb(entry) || jsonb_build_object(
         'lines',
         COALESCE(
           (
             SELECT jsonb_agg(to_jsonb(line) ORDER BY line.sort_order, line.id)
             FROM public.journal_entry_lines line
             WHERE line.journal_entry_id = entry.id
           ),
           '[]'::jsonb
         )
       ) AS entry
     FROM public.journal_entries entry
     WHERE entry.company_id = $1
       AND entry.id = $2`,
    [companyId, entryId],
  )
  return result.rows[0]!.entry
}

describe('shared journal lineage contract', () => {
  it('returns corrections through depth 32 and one terminal storno at depth 33', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const lineage = await seedMaximumLineage(client, tenant)
      const result = await client.query<{
        result: {
          valid: boolean
          row_count: number
          max_depth: number
          max_correction_depth: number
          terminal_storno_depth: number
          rows: Array<{
            id: string
            edge_kind: string
            depth: number
            cycle: boolean
          }>
        }
      }>(
        `SELECT public.get_journal_lineage($1, ARRAY[$2]::uuid[]) AS result`,
        [tenant.companyId, lineage.rootId],
      )

      const payload = result.rows[0]!.result
      expect(payload.valid).toBe(true)
      expect(payload.row_count).toBe(66)
      expect(payload.max_depth).toBe(TERMINAL_STORNO_DEPTH)
      expect(payload.max_correction_depth).toBe(MAX_CORRECTION_DEPTH)
      expect(payload.terminal_storno_depth).toBe(TERMINAL_STORNO_DEPTH)
      expect(payload.rows).toHaveLength(66)
      expect(payload.rows).toContainEqual(expect.objectContaining({
        id: lineage.terminalId,
        edge_kind: 'storno',
        depth: TERMINAL_STORNO_DEPTH,
        cycle: false,
      }))

      await client.query('SAVEPOINT reject_depth_33_correction')
      await expect(insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: lineage.correctionIds.at(-1)!,
      })).rejects.toThrow(/correction depth exceeds 32/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_depth_33_correction')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('enforces one committed correction and storno child per parent', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const rootId = await insertLineageEntry(client, tenant)
      await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: rootId,
      })
      await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'storno',
        reversesId: rootId,
      })

      await client.query('SAVEPOINT duplicate_correction')
      await expect(insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: rootId,
      })).rejects.toThrow(/uq_journal_entries_committed_correction_child|duplicate key/i)
      await client.query('ROLLBACK TO SAVEPOINT duplicate_correction')

      await client.query('SAVEPOINT duplicate_storno')
      await expect(insertLineageEntry(client, {
        ...tenant,
        sourceType: 'storno',
        reversesId: rootId,
      })).rejects.toThrow(/uq_journal_entries_committed_storno_child|duplicate key/i)
      await client.query('ROLLBACK TO SAVEPOINT duplicate_storno')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('rejects contradictory writes and fails closed on legacy malformed graphs', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const rootId = await insertLineageEntry(client, tenant)

      await client.query('SAVEPOINT contradictory_write')
      await expect(insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: rootId,
        reversesId: rootId,
      })).rejects.toThrow(/exactly one correction_of_id edge/i)
      await client.query('ROLLBACK TO SAVEPOINT contradictory_write')

      await client.query(`SET LOCAL session_replication_role = 'replica'`)
      const firstId = await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: rootId,
      })
      const secondId = await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'correction',
        correctionOfId: firstId,
      })
      await client.query(
        `UPDATE public.journal_entries SET reverses_id = $2 WHERE id = $1`,
        [firstId, secondId],
      )
      await client.query(`SET LOCAL session_replication_role = 'origin'`)

      await client.query('SAVEPOINT malformed_cycle')
      await expect(client.query(
        `SELECT public.get_journal_lineage($1, ARRAY[$2]::uuid[])`,
        [tenant.companyId, rootId],
      )).rejects.toThrow(/cyclic, contradictory, ambiguous, or outside/i)
      await client.query('ROLLBACK TO SAVEPOINT malformed_cycle')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('fails closed when a committed lineage row has no committed_at', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const rootId = await insertLineageEntry(client, tenant)
      await client.query('SAVEPOINT null_committed_at')
      await client.query(`SET LOCAL session_replication_role = 'replica'`)
      const corrupted = await client.query<{ committed_at: string | null }>(
        `UPDATE public.journal_entries
         SET committed_at = NULL
         WHERE id = $1
         RETURNING committed_at`,
        [rootId],
      )
      await client.query(`SET LOCAL session_replication_role = 'origin'`)
      expect(corrupted.rows).toEqual([{ committed_at: null }])

      await expect(client.query(
        `SELECT public.get_journal_lineage($1, ARRAY[$2]::uuid[])`,
        [tenant.companyId, rootId],
      )).rejects.toThrow(/cyclic, contradictory, ambiguous, or outside/i)
      await client.query('ROLLBACK TO SAVEPOINT null_committed_at')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('allows transitional reversal writes but rejects a malformed final state at COMMIT', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const originalId = await insertLineageEntry(client, tenant)
      const reversalId = await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'storno',
        reversesId: originalId,
      })

      const transitionalRows = await client.query<{
        id: string
        status: string
        reverses_id: string | null
      }>(
        `SELECT id, status, reverses_id
         FROM public.journal_entries
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [[originalId, reversalId]],
      )
      expect(transitionalRows.rows).toEqual([
        { id: originalId, status: 'posted', reverses_id: null },
        {
          id: reversalId,
          status: 'posted',
          reverses_id: originalId,
        },
      ].sort((left, right) => left.id.localeCompare(right.id)))

      await expect(client.query('COMMIT')).rejects.toThrow(
        /journal lineage final state is contradictory/i,
      )
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('is company scoped for authenticated callers and rejects hidden roots', async () => {
    const owner = await seedCompany()
    const foreign = await seedCompany()
    const rootId = await insertPostedJournalEntry({
      ...owner,
      committedAt: '2026-06-01T10:00:00Z',
    })

    const own = await withUserContext(owner.userId, async (client) => {
      const result = await client.query<{ result: { valid: boolean } }>(
        `SELECT public.get_journal_lineage($1, ARRAY[$2]::uuid[]) AS result`,
        [owner.companyId, rootId],
      )
      return result.rows[0]!.result
    })
    expect(own.valid).toBe(true)

    await expect(withUserContext(foreign.userId, async (client) =>
      client.query(
        `SELECT public.get_journal_lineage($1, ARRAY[$2]::uuid[])`,
        [owner.companyId, rootId],
      ),
    )).rejects.toThrow(/missing, malformed, or outside company scope/i)
  })
})

describe('durable accounting publication contract', () => {
  it('persists the exact committed payload and first-snapshot projections', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    const eventType = 'journal_entry.committed'

    try {
      await client.query('BEGIN')
      const entityId = await insertLineageEntry(client, tenant)
      const entry = await readJournalEntryEventObject(
        client,
        tenant.companyId,
        entityId,
      )
      const publicationKey = `journal:${entityId}:committed`
      const payload = {
        companyId: tenant.companyId,
        userId: tenant.userId,
        entry,
      }
      expect(payload).toEqual({
        companyId: tenant.companyId,
        userId: tenant.userId,
        entry,
      })

      await client.query('SAVEPOINT reject_committed_payload_identity')
      await expect(recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId,
        userId: tenant.userId,
        payload: {
          ...payload,
          entry: {
            ...entry,
            lines: [],
          },
        },
      })).rejects.toThrow(/committed accounting publication payload identity is invalid/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_committed_payload_identity')

      const firstWebhookId = await insertWebhook(client, tenant.companyId, eventType)
      const secondInitialWebhookId = await insertWebhook(
        client,
        tenant.companyId,
        eventType,
      )
      const first = await recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId,
        userId: tenant.userId,
        payload,
      })
      expect(first).toMatchObject({
        status: 'published',
        publication_key: publicationKey,
        subscriber_count: 2,
        webhook_delivery_count: 2,
      })

      const laterWebhookId = await insertWebhook(client, tenant.companyId, eventType)
      const retry = await recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId,
        userId: tenant.userId,
        payload,
      })
      expect(retry).toMatchObject({
        status: 'already_published',
        publication_id: first.publication_id,
        event_log_sequence: first.event_log_sequence,
        subscriber_count: 2,
        webhook_delivery_count: 2,
      })

      const projections = await client.query<{
        publication_payload: Record<string, unknown>
        publication_entity_id: string
        event_data: Record<string, unknown>
        event_entity_id: string
        event_publication_id: string
        subscriber_id: string
        delivery_payload: Record<string, unknown>
        delivery_subscriber_id: string
        webhook_id: string
      }>(
        `SELECT
           publication.payload AS publication_payload,
           publication.entity_id AS publication_entity_id,
           event.data AS event_data,
           event.entity_id AS event_entity_id,
           event.accounting_publication_id AS event_publication_id,
           subscriber.id AS subscriber_id,
           delivery.payload AS delivery_payload,
           delivery.accounting_publication_subscriber_id AS delivery_subscriber_id,
           subscriber.webhook_id
         FROM public.accounting_publications publication
         JOIN public.event_log event
           ON event.accounting_publication_id = publication.id
         JOIN public.accounting_publication_subscribers subscriber
           ON subscriber.publication_id = publication.id
         JOIN public.webhook_deliveries delivery
           ON delivery.accounting_publication_subscriber_id = subscriber.id
         WHERE publication.id = $1
         ORDER BY subscriber.webhook_id`,
        [first.publication_id],
      )
      expect(projections.rows).toHaveLength(2)
      expect(projections.rows.map(row => row.webhook_id).sort()).toEqual(
        [firstWebhookId, secondInitialWebhookId].sort(),
      )
      expect(projections.rows.map(row => row.webhook_id)).not.toContain(laterWebhookId)
      for (const projection of projections.rows) {
        expect(projection.publication_payload).toEqual(payload)
        expect(projection.publication_entity_id).toBe(entityId)
        expect(projection.event_data).toEqual({ entry })
        expect(projection.event_entity_id).toBe(entityId)
        expect(projection.event_publication_id).toBe(first.publication_id)
        expect(projection.delivery_payload).toEqual({
          companyId: tenant.companyId,
          entry,
        })
        expect(projection.delivery_subscriber_id).toBe(projection.subscriber_id)
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('persists exact reversal projections and rejects payload identity drift', async () => {
    const tenant = await seedCompany()
    const client = await getPool().connect()
    const eventType = 'journal_entry.reversed'

    try {
      await client.query('BEGIN')
      const originalId = await insertLineageEntry(client, tenant)
      const reversalId = await insertLineageEntry(client, {
        ...tenant,
        sourceType: 'storno',
        reversesId: originalId,
      })
      await markReversed(client, originalId, reversalId)
      const originalEntry = await readJournalEntryEventObject(
        client,
        tenant.companyId,
        originalId,
      )
      const reversalEntry = await readJournalEntryEventObject(
        client,
        tenant.companyId,
        reversalId,
      )
      const publicationKey = `journal:${originalId}:reversed`
      const payload = {
        companyId: tenant.companyId,
        userId: tenant.userId,
        originalEntry,
        reversalEntry,
      }
      expect(payload).toEqual({
        companyId: tenant.companyId,
        userId: tenant.userId,
        originalEntry,
        reversalEntry,
      })

      const webhookId = await insertWebhook(client, tenant.companyId, eventType)
      const first = await recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId: reversalId,
        userId: tenant.userId,
        payload,
      })
      expect(first).toMatchObject({
        status: 'published',
        publication_key: publicationKey,
        subscriber_count: 1,
        webhook_delivery_count: 1,
      })

      const projection = await client.query<{
        publication_payload: Record<string, unknown>
        publication_entity_id: string
        event_data: Record<string, unknown>
        event_entity_id: string
        event_publication_id: string
        subscriber_id: string
        delivery_payload: Record<string, unknown>
        delivery_subscriber_id: string
        webhook_id: string
      }>(
        `SELECT
           publication.payload AS publication_payload,
           publication.entity_id AS publication_entity_id,
           event.data AS event_data,
           event.entity_id AS event_entity_id,
           event.accounting_publication_id AS event_publication_id,
           subscriber.id AS subscriber_id,
           delivery.payload AS delivery_payload,
           delivery.accounting_publication_subscriber_id AS delivery_subscriber_id,
           subscriber.webhook_id
         FROM public.accounting_publications publication
         JOIN public.event_log event
           ON event.accounting_publication_id = publication.id
         JOIN public.accounting_publication_subscribers subscriber
           ON subscriber.publication_id = publication.id
         JOIN public.webhook_deliveries delivery
           ON delivery.accounting_publication_subscriber_id = subscriber.id
         WHERE publication.id = $1`,
        [first.publication_id],
      )
      expect(projection.rows).toHaveLength(1)
      const row = projection.rows[0]!
      expect(row.publication_payload).toEqual(payload)
      expect(row.publication_entity_id).toBe(reversalId)
      expect(row.event_data).toEqual({ originalEntry, reversalEntry })
      expect(row.event_entity_id).toBe(reversalId)
      expect(row.event_publication_id).toBe(first.publication_id)
      expect(row.delivery_payload).toEqual({
        companyId: tenant.companyId,
        originalEntry,
        reversalEntry,
      })
      expect(row.delivery_subscriber_id).toBe(row.subscriber_id)
      expect(row.webhook_id).toBe(webhookId)

      await client.query('SAVEPOINT reject_payload_identity_drift')
      await expect(recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId: reversalId,
        userId: tenant.userId,
        payload: {
          ...payload,
          reversalEntry: {
            ...reversalEntry,
            lines: [],
          },
        },
      })).rejects.toThrow(/reversed accounting publication payload identity is invalid/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_payload_identity_drift')

      await client.query(
        `DELETE FROM public.webhook_deliveries
         WHERE accounting_publication_subscriber_id = $1`,
        [row.subscriber_id],
      )
      await client.query('SAVEPOINT reject_missing_delivery')
      await expect(recordPublication(client, {
        companyId: tenant.companyId,
        publicationKey,
        eventType,
        entityId: reversalId,
        userId: tenant.userId,
        payload,
      })).rejects.toThrow(/delivery snapshot is missing or contradictory/i)
      await client.query('ROLLBACK TO SAVEPOINT reject_missing_delivery')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('P1 least-privilege metadata', () => {
  it('pins safe search paths, invoker modes, grants, and private publication tables', async () => {
    const functions = await getPool().query<{
      signature: string
      prosecdef: boolean
      proconfig: string[] | null
      anon_exec: boolean
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
    }>(
      `SELECT
         p.oid::regprocedure::text AS signature,
         p.prosecdef,
         p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS public_exec
       FROM pg_proc p
       JOIN pg_namespace namespace ON namespace.oid = p.pronamespace
       WHERE namespace.nspname = 'public'
         AND p.proname IN (
           'get_journal_lineage',
           'record_accounting_publication',
           'validate_journal_lineage_edge'
         )
       ORDER BY p.proname`,
    )

    expect(functions.rows).toEqual([
      {
        signature: 'get_journal_lineage(uuid,uuid[])',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, public'],
        anon_exec: false,
        authenticated_exec: true,
        service_exec: true,
        public_exec: false,
      },
      {
        signature: 'record_accounting_publication(uuid,text,text,uuid,uuid,jsonb)',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, public'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
      {
        signature: 'validate_journal_lineage_edge()',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog, public'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
    ])

    const tables = await getPool().query<{
      relname: string
      rls_enabled: boolean
      policy_count: number
      authenticated_select: boolean
      service_select: boolean
    }>(
      `SELECT
         class.relname,
         class.relrowsecurity AS rls_enabled,
         (SELECT count(*)::int FROM pg_policy policy WHERE policy.polrelid = class.oid)
           AS policy_count,
         has_table_privilege('authenticated', class.oid, 'SELECT') AS authenticated_select,
         has_table_privilege('service_role', class.oid, 'SELECT') AS service_select
       FROM pg_class class
       JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'public'
         AND class.relname IN (
           'accounting_publications',
           'accounting_publication_subscribers'
         )
       ORDER BY class.relname`,
    )
    expect(tables.rows).toEqual([
      {
        relname: 'accounting_publication_subscribers',
        rls_enabled: true,
        policy_count: 0,
        authenticated_select: false,
        service_select: false,
      },
      {
        relname: 'accounting_publications',
        rls_enabled: true,
        policy_count: 0,
        authenticated_select: false,
        service_select: false,
      },
    ])

    const privateSchema = await getPool().query<{
      anon_access: boolean
      authenticated_access: boolean
      service_access: boolean
      public_access: boolean
    }>(
      `SELECT
         (
           has_schema_privilege('anon', namespace.oid, 'USAGE')
           OR has_schema_privilege('anon', namespace.oid, 'CREATE')
         ) AS anon_access,
         (
           has_schema_privilege('authenticated', namespace.oid, 'USAGE')
           OR has_schema_privilege('authenticated', namespace.oid, 'CREATE')
         ) AS authenticated_access,
         (
           has_schema_privilege('service_role', namespace.oid, 'USAGE')
           OR has_schema_privilege('service_role', namespace.oid, 'CREATE')
         ) AS service_access,
         EXISTS (
           SELECT 1
           FROM aclexplode(
             COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
           ) acl
           WHERE acl.grantee = 0
         ) AS public_access
       FROM pg_namespace namespace
       WHERE namespace.nspname = 'accounting_private'`,
    )
    expect(privateSchema.rows).toEqual([{
      anon_access: false,
      authenticated_access: false,
      service_access: false,
      public_access: false,
    }])

    const privateFunctions = await getPool().query<{
      signature: string
      prosecdef: boolean
      proconfig: string[] | null
      anon_exec: boolean
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
    }>(
      `SELECT
         p.oid::regprocedure::text AS signature,
         p.prosecdef,
         p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ) AS public_exec
       FROM pg_proc p
       JOIN pg_namespace namespace ON namespace.oid = p.pronamespace
       WHERE namespace.nspname = 'accounting_private'
         AND p.proname IN (
           'grant_accounting_command_capability',
           'has_accounting_command_capability',
           'revoke_accounting_command_capability',
           'revoke_all_accounting_command_capabilities'
         )
       ORDER BY p.proname`,
    )
    expect(privateFunctions.rows).toEqual([
      {
        signature:
          'accounting_private.grant_accounting_command_capability(text,uuid,uuid)',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, accounting_private'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
      {
        signature:
          'accounting_private.has_accounting_command_capability(text,uuid,uuid)',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, accounting_private'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
      {
        signature:
          'accounting_private.revoke_accounting_command_capability(text,uuid,uuid)',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, accounting_private'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
      {
        signature:
          'accounting_private.revoke_all_accounting_command_capabilities()',
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, accounting_private'],
        anon_exec: false,
        authenticated_exec: false,
        service_exec: false,
        public_exec: false,
      },
    ])

    const capabilityTable = await getPool().query<{
      rls_enabled: boolean
      policy_count: number
      anon_access: boolean
      authenticated_access: boolean
      service_access: boolean
      public_access: boolean
    }>(
      `SELECT
         class.relrowsecurity AS rls_enabled,
         (SELECT count(*)::int FROM pg_policy policy WHERE policy.polrelid = class.oid)
           AS policy_count,
         (
           has_table_privilege('anon', class.oid, 'SELECT')
           OR has_table_privilege('anon', class.oid, 'INSERT')
           OR has_table_privilege('anon', class.oid, 'UPDATE')
           OR has_table_privilege('anon', class.oid, 'DELETE')
           OR has_table_privilege('anon', class.oid, 'TRUNCATE')
           OR has_table_privilege('anon', class.oid, 'REFERENCES')
           OR has_table_privilege('anon', class.oid, 'TRIGGER')
         ) AS anon_access,
         (
           has_table_privilege('authenticated', class.oid, 'SELECT')
           OR has_table_privilege('authenticated', class.oid, 'INSERT')
           OR has_table_privilege('authenticated', class.oid, 'UPDATE')
           OR has_table_privilege('authenticated', class.oid, 'DELETE')
           OR has_table_privilege('authenticated', class.oid, 'TRUNCATE')
           OR has_table_privilege('authenticated', class.oid, 'REFERENCES')
           OR has_table_privilege('authenticated', class.oid, 'TRIGGER')
         ) AS authenticated_access,
         (
           has_table_privilege('service_role', class.oid, 'SELECT')
           OR has_table_privilege('service_role', class.oid, 'INSERT')
           OR has_table_privilege('service_role', class.oid, 'UPDATE')
           OR has_table_privilege('service_role', class.oid, 'DELETE')
           OR has_table_privilege('service_role', class.oid, 'TRUNCATE')
           OR has_table_privilege('service_role', class.oid, 'REFERENCES')
           OR has_table_privilege('service_role', class.oid, 'TRIGGER')
         ) AS service_access,
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(class.relacl, acldefault('r', class.relowner))) acl
           WHERE acl.grantee = 0
         ) AS public_access
       FROM pg_class class
       JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'accounting_private'
         AND class.relname = 'accounting_command_capabilities'`,
    )
    expect(capabilityTable.rows).toEqual([{
      rls_enabled: true,
      policy_count: 0,
      anon_access: false,
      authenticated_access: false,
      service_access: false,
      public_access: false,
    }])
  })
})
