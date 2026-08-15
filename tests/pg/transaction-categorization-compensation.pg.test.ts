import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'
import { getPool, runAsServiceRole, withUserContext } from './setup'

interface CategorizationFixture {
  userId: string
  companyId: string
  transactionId: string
  entryId: string
}

async function withCommittedUserContext<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE authenticated`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function seedAttachedCategorization(): Promise<CategorizationFixture> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const cashAccountId = await insertCashAccount({
    companyId,
    ledgerAccount: '1930',
    currency: 'SEK',
  })
  const transactionId = await insertTransaction({
    companyId,
    userId,
    amount: -250,
    date: '2026-07-01',
    description: 'Compensate me',
    cashAccountId,
  })
  const entryId = await insertDraftJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-07-01',
    description: 'Categorization',
    sourceType: 'bank_transaction',
    sourceId: transactionId,
  })
  await getPool().query(
    `UPDATE public.journal_entries
     SET categorization_category = 'expense_office', categorization_is_business = true
     WHERE id = $1`,
    [entryId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '6110', 250, 0, 1), ($1, '1930', 0, 250, 2)`,
    [entryId],
  )
  await getPool().query(
    `SELECT * FROM public.commit_journal_entry($1, $2, 'user_accept', NULL, 'system', 'pg-real')`,
    [companyId, entryId],
  )
  await withCommittedUserContext(userId, async (client) => {
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.attach_transaction_categorization(
         $1, $2, $3, $4, NULL, $5, '1930', 250,
         'expense_office', true, $6::jsonb
       ) AS result`,
      [
        companyId,
        transactionId,
        entryId,
        userId,
        cashAccountId,
        JSON.stringify([
          {
            account_number: '6110',
            debit_amount: 250,
            credit_amount: 0,
            line_description: null,
            dimensions: {},
          },
          {
            account_number: '1930',
            debit_amount: 0,
            credit_amount: 250,
            line_description: null,
            dimensions: {},
          },
        ]),
      ],
    )
    expect(result.rows[0]!.result.status).toBe('applied')
  })
  return { userId, companyId, transactionId, entryId }
}

async function compensate(
  fixture: CategorizationFixture,
): Promise<Record<string, unknown>> {
  return withCommittedUserContext(fixture.userId, async (client) => {
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.compensate_transaction_categorization(
         $1, $2, $3, 'api_key', NULL, 'forged'
       ) AS result`,
      [fixture.companyId, fixture.transactionId, fixture.entryId],
    )
    return result.rows[0]!.result
  })
}

async function compensateAsServiceRole(
  fixture: CategorizationFixture,
  actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron' | 'system' | 'agent_chat',
  actorId: string | null,
  actorLabel: string | null,
): Promise<Record<string, unknown>> {
  return runAsServiceRole(async (client) => {
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.compensate_transaction_categorization(
         $1, $2, $3, $4, $5, $6
       ) AS result`,
      [
        fixture.companyId,
        fixture.transactionId,
        fixture.entryId,
        actorType,
        actorId,
        actorLabel,
      ],
    )
    return result.rows[0]!.result
  })
}

async function insertWebhook(companyId: string, eventType: string): Promise<string> {
  const webhookId = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks (
       id, company_id, name, event_type, webhook_url, secret, active, api_version_pinned
     ) VALUES ($1, $2, 'M5 publication projection', $3, $4, $5, true, '2026-05-12')`,
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

describe('M5 transaction categorization compensation', () => {
  it('atomically stornoes, clears only the exact pointer, publishes, and retries exactly', async () => {
    const fixture = await seedAttachedCategorization()
    const first = await compensate(fixture)
    expect(first).toMatchObject({
      status: 'applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      root_journal_entry_id: fixture.entryId,
      original_journal_entry_id: fixture.entryId,
      actor_type: 'user',
      actor_id: fixture.userId,
      actor_label: null,
    })
    expect(first.publications).toHaveLength(2)

    const reversalId = first.reversal_journal_entry_id as string
    const state = await getPool().query<{
      pointer: string | null
      original_status: string
      reversed_by_id: string
      reversal_status: string
      reversal_commit_method: string
      reversal_actor_type: string
      reversal_actor_label: string | null
      command_count: string
      publication_count: string
    }>(
      `SELECT
         transaction_row.journal_entry_id::text AS pointer,
         original.status AS original_status,
         original.reversed_by_id::text,
         reversal.status AS reversal_status,
         reversal.commit_method AS reversal_commit_method,
         reversal.committed_actor_type AS reversal_actor_type,
         reversal.committed_actor_label AS reversal_actor_label,
         (SELECT count(*) FROM public.transaction_categorization_compensations command
          WHERE command.original_journal_entry_id = $2) AS command_count,
         (SELECT count(*) FROM public.accounting_publications publication
          WHERE publication.publication_key IN ($3, $4)) AS publication_count
       FROM public.transactions transaction_row
       JOIN public.journal_entries original ON original.id = $2
       JOIN public.journal_entries reversal ON reversal.id = $5
       WHERE transaction_row.id = $1`,
      [
        fixture.transactionId,
        fixture.entryId,
        `journal:${reversalId}:committed`,
        `journal:${fixture.entryId}:reversed`,
        reversalId,
      ],
    )
    expect(state.rows[0]).toEqual({
      pointer: null,
      original_status: 'reversed',
      reversed_by_id: reversalId,
      reversal_status: 'posted',
      reversal_commit_method: 'user_accept',
      reversal_actor_type: 'user',
      reversal_actor_label: null,
      command_count: '1',
      publication_count: '2',
    })

    const retry = await compensate(fixture)
    expect(retry).toMatchObject({
      status: 'already_applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      original_journal_entry_id: fixture.entryId,
      reversal_journal_entry_id: reversalId,
      actor_type: 'user',
      actor_id: fixture.userId,
    })
    expect(retry.publications).toEqual(first.publications)

    const identities = await getPool().query<{ commands: string; stornos: string }>(
      `SELECT
         (SELECT count(*) FROM public.transaction_categorization_compensations command
          WHERE command.original_journal_entry_id = $1) AS commands,
         (SELECT count(*) FROM public.journal_entries entry
          WHERE entry.reverses_id = $1 AND entry.source_type = 'storno') AS stornos`,
      [fixture.entryId],
    )
    expect(identities.rows[0]).toEqual({ commands: '1', stornos: '1' })
  })

  it('uses a labeled nullable service actor and publishes exact durable projections', async () => {
    const fixture = await seedAttachedCategorization()
    const committedWebhookId = await insertWebhook(
      fixture.companyId,
      'journal_entry.committed',
    )
    const reversedWebhookId = await insertWebhook(
      fixture.companyId,
      'journal_entry.reversed',
    )
    const actorLabel = 'WP5 categorization cron'

    const first = await compensateAsServiceRole(fixture, 'cron', randomUUID(), actorLabel)
    const reversalId = first.reversal_journal_entry_id as string
    const publications = first.publications as Array<{
      publication_id: string
      event_key: string
      event_type: string
    }>
    expect(first).toEqual({
      status: 'applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      root_journal_entry_id: fixture.entryId,
      original_journal_entry_id: fixture.entryId,
      reversal_journal_entry_id: reversalId,
      actor_type: 'cron',
      actor_id: null,
      actor_label: actorLabel,
      publications,
    })
    expect(publications).toEqual([
      {
        publication_id: expect.any(String),
        event_key: `journal:${reversalId}:committed`,
        event_type: 'journal_entry.committed',
      },
      {
        publication_id: expect.any(String),
        event_key: `journal:${fixture.entryId}:reversed`,
        event_type: 'journal_entry.reversed',
      },
    ])

    const commitProvenance = await getPool().query<{
      commit_method: string
      committed_actor_type: string
      committed_actor_label: string
    }>(
      `SELECT commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries
       WHERE id = $1`,
      [reversalId],
    )
    expect(commitProvenance.rows[0]).toEqual({
      commit_method: 'api_key',
      committed_actor_type: 'cron',
      committed_actor_label: actorLabel,
    })

    const eventObjects = await getPool().query<{
      original_entry: Record<string, unknown>
      reversal_entry: Record<string, unknown>
    }>(
      `SELECT
         public.accounting_journal_entry_event_object($1, $2) AS original_entry,
         public.accounting_journal_entry_event_object($1, $3) AS reversal_entry`,
      [fixture.companyId, fixture.entryId, reversalId],
    )
    const originalEntry = eventObjects.rows[0]!.original_entry
    const reversalEntry = eventObjects.rows[0]!.reversal_entry
    const committedPayload = {
      companyId: fixture.companyId,
      userId: fixture.userId,
      entry: reversalEntry,
    }
    const reversedPayload = {
      companyId: fixture.companyId,
      userId: fixture.userId,
      originalEntry,
      reversalEntry,
    }

    const artifacts = await getPool().query<{
      publication_id: string
      publication_key: string
      publication_event_type: string
      publication_entity_id: string
      publication_user_id: string
      publication_payload: Record<string, unknown>
      event_publication_id: string
      event_company_id: string
      event_user_id: string
      event_type: string
      event_entity_id: string
      event_data: Record<string, unknown>
      webhook_id: string
      webhook_company_id: string
      webhook_event_type: string
      webhook_payload: Record<string, unknown>
    }>(
      `SELECT
         publication.id::text AS publication_id,
         publication.publication_key,
         publication.event_type AS publication_event_type,
         publication.entity_id::text AS publication_entity_id,
         publication.user_id::text AS publication_user_id,
         publication.payload AS publication_payload,
         event.accounting_publication_id::text AS event_publication_id,
         event.company_id::text AS event_company_id,
         event.user_id::text AS event_user_id,
         event.event_type,
         event.entity_id::text AS event_entity_id,
         event.data AS event_data,
         delivery.webhook_id::text AS webhook_id,
         delivery.company_id::text AS webhook_company_id,
         delivery.event_type AS webhook_event_type,
         delivery.payload AS webhook_payload
       FROM public.accounting_publications publication
       JOIN public.event_log event
         ON event.accounting_publication_id = publication.id
       JOIN public.accounting_publication_subscribers subscriber
         ON subscriber.publication_id = publication.id
       JOIN public.webhook_deliveries delivery
         ON delivery.accounting_publication_subscriber_id = subscriber.id
       WHERE publication.id = ANY($1::uuid[])
       ORDER BY publication.event_type`,
      [publications.map((publication) => publication.publication_id)],
    )
    expect(artifacts.rows).toEqual([
      {
        publication_id: publications[0]!.publication_id,
        publication_key: `journal:${reversalId}:committed`,
        publication_event_type: 'journal_entry.committed',
        publication_entity_id: reversalId,
        publication_user_id: fixture.userId,
        publication_payload: committedPayload,
        event_publication_id: publications[0]!.publication_id,
        event_company_id: fixture.companyId,
        event_user_id: fixture.userId,
        event_type: 'journal_entry.committed',
        event_entity_id: reversalId,
        event_data: { entry: reversalEntry },
        webhook_id: committedWebhookId,
        webhook_company_id: fixture.companyId,
        webhook_event_type: 'journal_entry.committed',
        webhook_payload: {
          companyId: fixture.companyId,
          entry: reversalEntry,
        },
      },
      {
        publication_id: publications[1]!.publication_id,
        publication_key: `journal:${fixture.entryId}:reversed`,
        publication_event_type: 'journal_entry.reversed',
        publication_entity_id: reversalId,
        publication_user_id: fixture.userId,
        publication_payload: reversedPayload,
        event_publication_id: publications[1]!.publication_id,
        event_company_id: fixture.companyId,
        event_user_id: fixture.userId,
        event_type: 'journal_entry.reversed',
        event_entity_id: reversalId,
        event_data: { originalEntry, reversalEntry },
        webhook_id: reversedWebhookId,
        webhook_company_id: fixture.companyId,
        webhook_event_type: 'journal_entry.reversed',
        webhook_payload: {
          companyId: fixture.companyId,
          originalEntry,
          reversalEntry,
        },
      },
    ])

    const retry = await compensateAsServiceRole(fixture, 'cron', randomUUID(), actorLabel)
    expect(retry).toEqual({
      status: 'already_applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      root_journal_entry_id: fixture.entryId,
      original_journal_entry_id: fixture.entryId,
      reversal_journal_entry_id: reversalId,
      actor_type: 'cron',
      actor_id: null,
      actor_label: actorLabel,
      publications,
    })

    const conflictingRetry = await compensateAsServiceRole(
      fixture,
      'cron',
      randomUUID(),
      'different verified cron',
    )
    expect(conflictingRetry).toEqual({
      status: 'conflict',
      reason: 'stored categorization compensation identity differs',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      root_journal_entry_id: fixture.entryId,
      original_journal_entry_id: fixture.entryId,
      reversal_journal_entry_id: reversalId,
    })
  })

  it('maps a labelled agent-chat command to agent commit provenance', async () => {
    const fixture = await seedAttachedCategorization()
    const actorLabel = 'verified categorization agent'
    const result = await compensateAsServiceRole(
      fixture,
      'agent_chat',
      randomUUID(),
      actorLabel,
    )
    const reversalId = result.reversal_journal_entry_id as string
    const provenance = await getPool().query<{
      commit_method: string
      committed_actor_type: string
      committed_actor_label: string
    }>(
      `SELECT commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries
       WHERE id = $1`,
      [reversalId],
    )
    expect(provenance.rows[0]).toEqual({
      commit_method: 'agent',
      committed_actor_type: 'agent_chat',
      committed_actor_label: actorLabel,
    })
  })

  it('rejects a nullable non-user service actor without a verified label', async () => {
    const fixture = await seedAttachedCategorization()

    await expect(
      compensateAsServiceRole(fixture, 'cron', null, null),
    ).rejects.toMatchObject({ code: '42501' })

    await expect(
      compensateAsServiceRole(fixture, 'cron', null, '   '),
    ).rejects.toMatchObject({ code: '42501' })

    const state = await getPool().query<{
      pointer: string
      original_status: string
      commands: string
      stornos: string
    }>(
      `SELECT
         transaction_row.journal_entry_id::text AS pointer,
         original.status AS original_status,
         (SELECT count(*) FROM public.transaction_categorization_compensations command
          WHERE command.original_journal_entry_id = $2) AS commands,
         (SELECT count(*) FROM public.journal_entries reversal
          WHERE reversal.reverses_id = $2 AND reversal.source_type = 'storno') AS stornos
       FROM public.transactions transaction_row
       JOIN public.journal_entries original ON original.id = $2
       WHERE transaction_row.id = $1`,
      [fixture.transactionId, fixture.entryId],
    )
    expect(state.rows[0]).toEqual({
      pointer: fixture.entryId,
      original_status: 'posted',
      commands: '0',
      stornos: '0',
    })
  })

  it('accepts only a current company member as a service user actor', async () => {
    const fixture = await seedAttachedCategorization()
    const outsider = await seedCompany()

    await expect(
      compensateAsServiceRole(fixture, 'user', outsider.userId, null),
    ).rejects.toMatchObject({ code: '42501' })

    const applied = await compensateAsServiceRole(
      fixture,
      'user',
      fixture.userId,
      'ignored user label',
    )
    expect(applied).toMatchObject({
      status: 'applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      actor_type: 'user',
      actor_id: fixture.userId,
      actor_label: null,
    })
  })

  it('blocks staged pointer drift before compensation can create a storno', async () => {
    const fixture = await seedAttachedCategorization()

    await expect(
      getPool().query(
        `UPDATE public.transactions SET journal_entry_id = NULL WHERE id = $1`,
        [fixture.transactionId],
      ),
    ).rejects.toThrow(
      /Bank categorization pointers may change only through the atomic attachment or compensation RPC/,
    )

    const state = await getPool().query<{
      pointer: string
      original_status: string
      stornos: string
      commands: string
      publications: string
    }>(
      `SELECT
         transaction_row.journal_entry_id::text AS pointer,
         original.status AS original_status,
         (SELECT count(*) FROM public.journal_entries reversal
          WHERE reversal.reverses_id = $1 AND reversal.source_type = 'storno') AS stornos,
         (SELECT count(*) FROM public.transaction_categorization_compensations command
          WHERE command.original_journal_entry_id = $1) AS commands,
         (SELECT count(*) FROM public.accounting_publications publication
          WHERE publication.publication_key = $2) AS publications
       FROM public.journal_entries original
       JOIN public.transactions transaction_row
         ON transaction_row.id = $3
       WHERE original.id = $1`,
      [fixture.entryId, `journal:${fixture.entryId}:reversed`, fixture.transactionId],
    )
    expect(state.rows[0]).toEqual({
      pointer: fixture.entryId,
      original_status: 'posted',
      stornos: '0',
      commands: '0',
      publications: '0',
    })
  })

  it('denies another tenant without changing the attached voucher', async () => {
    const fixture = await seedAttachedCategorization()
    const outsider = await seedCompany()
    await expect(
      withUserContext(outsider.userId, async (client) => {
        await client.query(
          `SELECT public.compensate_transaction_categorization(
             $1, $2, $3, 'user', $4, NULL
           )`,
          [fixture.companyId, fixture.transactionId, fixture.entryId, outsider.userId],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })

    const state = await getPool().query<{ status: string; pointer: string }>(
      `SELECT entry.status, transaction_row.journal_entry_id::text AS pointer
       FROM public.journal_entries entry
       JOIN public.transactions transaction_row ON transaction_row.id = $2
       WHERE entry.id = $1`,
      [fixture.entryId, fixture.transactionId],
    )
    expect(state.rows[0]).toEqual({ status: 'posted', pointer: fixture.entryId })
  })

  it('keeps compensation storage private and exposes one safe RPC signature', async () => {
    const tablePrivileges = await getPool().query<{
      authenticated_select: boolean
      service_select: boolean
    }>(
      `SELECT
         has_table_privilege('authenticated', 'public.transaction_categorization_compensations', 'SELECT')
           AS authenticated_select,
         has_table_privilege('service_role', 'public.transaction_categorization_compensations', 'SELECT')
           AS service_select`,
    )
    expect(tablePrivileges.rows[0]).toEqual({
      authenticated_select: false,
      service_select: false,
    })

    const functions = await getPool().query<{
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
           'compensate_transaction_categorization',
           'resolve_categorization_compensation_actor',
           'categorization_reversal_lines_match'
         )
       ORDER BY p.proname`,
    )
    const byName = Object.fromEntries(functions.rows.map((row) => [row.name, row]))
    expect(byName.compensate_transaction_categorization).toMatchObject({
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
      security_definer: true,
    })
    expect(byName.compensate_transaction_categorization.config).toContain(
      'search_path=pg_catalog, public',
    )
    expect(byName.resolve_categorization_compensation_actor).toMatchObject({
      authenticated_exec: false,
      service_exec: false,
      public_exec: false,
    })
    expect(byName.categorization_reversal_lines_match).toMatchObject({
      authenticated_exec: false,
      service_exec: false,
      public_exec: false,
    })
  })
})
