import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertCashAccount,
  insertDraftJournalEntry,
  insertTransaction,
  seedCompany,
} from './fixtures'
import { getPool, withUserContext } from './setup'

type AttachmentFixture = {
  userId: string
  companyId: string
  transactionId: string
  cashAccountId: string
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
async function seedAttachmentFixture(category = 'expense_software'): Promise<AttachmentFixture> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const cashAccountId = await insertCashAccount({
    companyId,
    ledgerAccount: '1930',
    currency: 'SEK',
  })
  const transactionId = await insertTransaction({
    companyId,
    userId,
    amount: -100,
    date: '2026-06-01',
    description: 'Software',
    cashAccountId,
  })
  const entryId = await insertDraftJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    entryDate: '2026-06-01',
    description: 'Categorized software',
    sourceType: 'bank_transaction',
    sourceId: transactionId,
  })
  await getPool().query(
    `UPDATE public.journal_entries
     SET categorization_category = $1, categorization_is_business = true
     WHERE id = $2`,
    [category, entryId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '6540', 100, 0, 1), ($1, '1930', 0, 100, 2)`,
    [entryId],
  )
  await getPool().query(
    `SELECT * FROM public.commit_journal_entry($1, $2, 'user_accept', NULL, 'system', 'pg-real')`,
    [companyId, entryId],
  )
  return { userId, companyId, transactionId, cashAccountId, entryId }
}

const EXPECTED_LINES = [
  {
    account_number: '6540',
    debit_amount: 100,
    credit_amount: 0,
    line_description: null,
    dimensions: {},
  },
  {
    account_number: '1930',
    debit_amount: 0,
    credit_amount: 100,
    line_description: null,
    dimensions: {},
  },
]

async function attach(fixture: AttachmentFixture): Promise<Record<string, unknown>> {
  return withCommittedUserContext(fixture.userId, async (client) => {
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT public.attach_transaction_categorization(
         $1, $2, $3, $4, NULL, $5, '1930', 100,
         'expense_software', true, $6::jsonb
       ) AS result`,
      [
        fixture.companyId,
        fixture.transactionId,
        fixture.entryId,
        fixture.userId,
        fixture.cashAccountId,
        JSON.stringify(EXPECTED_LINES),
      ],
    )
    return result.rows[0]!.result
  })
}

describe('M4 transaction categorization attachment', () => {
  it('attaches one exact posted categorization after full provenance verification', async () => {
    const fixture = await seedAttachmentFixture()
    await getPool().query(
      `INSERT INTO public.webhooks (
         company_id,
         name,
         event_type,
         webhook_url,
         secret,
         active,
         api_version_pinned
       ) VALUES (
         $1,
         'M4 attachment projection',
         'journal_entry.committed',
         'https://example.invalid/m4-attachment',
         'm4-attachment-secret',
         true,
         '2026-05-12'
       )`,
      [fixture.companyId],
    )
    const before = await getPool().query<{ publications: string }>(
      `SELECT count(*) AS publications
       FROM public.accounting_publications
       WHERE publication_key = $1`,
      [`journal:${fixture.entryId}:committed`],
    )
    expect(before.rows[0]!.publications).toBe('0')
    const first = await attach(fixture)
    expect(first).toMatchObject({
      status: 'applied',
      company_id: fixture.companyId,
      transaction_id: fixture.transactionId,
      journal_entry_id: fixture.entryId,
      readback: {
        transaction: {
          id: fixture.transactionId,
          companyId: fixture.companyId,
          journalEntryId: fixture.entryId,
          cashAccountId: fixture.cashAccountId,
          amountSek: 100,
          category: 'expense_software',
          isBusiness: true,
        },
        journalEntry: {
          id: fixture.entryId,
          companyId: fixture.companyId,
          status: 'posted',
          sourceType: 'bank_transaction',
          sourceId: fixture.transactionId,
          category: 'expense_software',
          isBusiness: true,
        },
      },
      publication: {
        event_key: `journal:${fixture.entryId}:committed`,
        event_type: 'journal_entry.committed',
      },
    })
    expect((first.publication as Record<string, unknown>).publication_id).toEqual(
      expect.any(String),
    )
    const after = await getPool().query<{ publications: string }>(
      `SELECT count(*) AS publications
       FROM public.accounting_publications
       WHERE publication_key = $1`,
      [`journal:${fixture.entryId}:committed`],
    )
    expect(after.rows[0]!.publications).toBe('1')

    const expectedEntryResult = await getPool().query<{
      entry: Record<string, unknown>
      lines: Record<string, unknown>[]
    }>(
      `SELECT
         to_jsonb(entry) AS entry,
         ARRAY(
           SELECT to_jsonb(line)
           FROM public.journal_entry_lines line
           WHERE line.journal_entry_id = entry.id
           ORDER BY line.sort_order, line.id
         ) AS lines
       FROM public.journal_entries entry
       WHERE entry.id = $1`,
      [fixture.entryId],
    )
    const expectedEntry = {
      ...expectedEntryResult.rows[0]!.entry,
      lines: expectedEntryResult.rows[0]!.lines,
    }
    const expectedDurablePayload = {
      companyId: fixture.companyId,
      userId: fixture.userId,
      entry: expectedEntry,
    }
    const artifacts = await getPool().query<{
      publication_key: string
      entity_id: string
      event_entity_id: string
      durable_payload: Record<string, unknown>
      event_data: Record<string, unknown>
      webhook_payload: Record<string, unknown>
    }>(
      `SELECT
         publication.publication_key,
         publication.entity_id::text,
         event.entity_id::text AS event_entity_id,
         publication.payload AS durable_payload,
         event.data AS event_data,
         delivery.payload AS webhook_payload
       FROM public.accounting_publications publication
       JOIN public.event_log event
         ON event.accounting_publication_id = publication.id
       JOIN public.accounting_publication_subscribers subscriber
         ON subscriber.publication_id = publication.id
       JOIN public.webhook_deliveries delivery
         ON delivery.accounting_publication_subscriber_id = subscriber.id
       WHERE publication.id = $1`,
      [(first.publication as Record<string, unknown>).publication_id],
    )
    expect(artifacts.rows).toEqual([
      {
        publication_key: `journal:${fixture.entryId}:committed`,
        entity_id: fixture.entryId,
        event_entity_id: fixture.entryId,
        durable_payload: expectedDurablePayload,
        event_data: { entry: expectedEntry },
        webhook_payload: {
          companyId: fixture.companyId,
          entry: expectedEntry,
        },
      },
    ])

    const transaction = await getPool().query<{
      journal_entry_id: string
      category: string
      is_business: boolean
    }>(
      `SELECT journal_entry_id::text, category, is_business
       FROM public.transactions WHERE id = $1`,
      [fixture.transactionId],
    )
    expect(transaction.rows[0]).toEqual({
      journal_entry_id: fixture.entryId,
      category: 'expense_software',
      is_business: true,
    })

    const retry = await attach(fixture)
    expect(retry).toMatchObject({
      status: 'already_applied',
      journal_entry_id: fixture.entryId,
      publication: first.publication,
    })
  })

  it('fails closed when the cash account mapping or staged category drifts', async () => {
    const cashDrift = await seedAttachmentFixture()
    await getPool().query(
      `UPDATE public.cash_accounts SET ledger_account = '1940' WHERE id = $1`,
      [cashDrift.cashAccountId],
    )
    await expect(attach(cashDrift)).rejects.toMatchObject({ code: '40001' })

    const categoryDrift = await seedAttachmentFixture('expense_office')
    await expect(attach(categoryDrift)).rejects.toMatchObject({ code: '23514' })

    const unchanged = await getPool().query<{ attached: string; publications: string }>(
      `SELECT
         (SELECT count(*) FROM public.transactions
          WHERE id IN ($1, $2) AND journal_entry_id IS NOT NULL) AS attached,
         (SELECT count(*) FROM public.accounting_publications
          WHERE publication_key IN ($3, $4)) AS publications`,
      [
        cashDrift.transactionId,
        categoryDrift.transactionId,
        `journal:${cashDrift.entryId}:committed`,
        `journal:${categoryDrift.entryId}:committed`,
      ],
    )
    expect(unchanged.rows[0]).toEqual({ attached: '0', publications: '0' })
  })

  it('rejects an authenticated direct pointer mutation with a forged legacy GUC', async () => {
    const fixture = await seedAttachmentFixture()
    await expect(
      withUserContext(fixture.userId, async (client) => {
        await client.query(
          `SELECT set_config('accounted.transaction_categorization', $1, true)`,
          [fixture.transactionId],
        )
        await client.query(
          `UPDATE public.transactions
           SET journal_entry_id = $2
           WHERE id = $1`,
          [fixture.transactionId, fixture.entryId],
        )
      }),
    ).rejects.toMatchObject({ code: '23514' })

    const transaction = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id::text
       FROM public.transactions
       WHERE id = $1`,
      [fixture.transactionId],
    )
    expect(transaction.rows).toEqual([{ journal_entry_id: null }])
  })

  it('rejects a missing posted identity, cross-tenant caller, and direct bank pointer mutation', async () => {
    const fixture = await seedAttachmentFixture()
    await expect(
      withUserContext(fixture.userId, async (client) => {
        await client.query(
          `SELECT public.attach_transaction_categorization(
             $1, $2, NULL, $3, NULL, $4, '1930', 100,
             'expense_software', true, $5::jsonb
           )`,
          [
            fixture.companyId,
            fixture.transactionId,
            fixture.userId,
            fixture.cashAccountId,
            JSON.stringify(EXPECTED_LINES),
          ],
        )
      }),
    ).rejects.toMatchObject({ code: '22004' })

    const outsider = await seedCompany()
    await expect(
      withUserContext(outsider.userId, async (client) => {
        await client.query(
          `SELECT public.attach_transaction_categorization(
             $1, $2, $3, $4, NULL, $5, '1930', 100,
             'expense_software', true, $6::jsonb
           )`,
          [
            fixture.companyId,
            fixture.transactionId,
            fixture.entryId,
            outsider.userId,
            fixture.cashAccountId,
            JSON.stringify(EXPECTED_LINES),
          ],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })

    expect((await attach(fixture)).status).toBe('applied')
    await expect(
      withUserContext(fixture.userId, (client) =>
        client.query(
          `UPDATE public.transactions SET journal_entry_id = NULL WHERE id = $1`,
          [fixture.transactionId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('uses safe search_path and least-privilege grants', async () => {
    const metadata = await getPool().query<{
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
      security_definer: boolean
      config: string[] | null
    }>(
      `SELECT
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         p.prosecdef AS security_definer,
         p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'attach_transaction_categorization'
         AND pg_get_function_identity_arguments(p.oid) =
           'p_company_id uuid, p_transaction_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_expected_journal_entry_id uuid, p_expected_cash_account_id uuid, p_expected_settlement_account text, p_expected_amount_sek numeric, p_expected_category text, p_expected_is_business boolean, p_expected_lines jsonb'`,
    )
    expect(metadata.rows).toHaveLength(1)
    expect(metadata.rows[0]).toMatchObject({
      authenticated_exec: true,
      service_exec: true,
      public_exec: false,
      security_definer: true,
    })
    expect(metadata.rows[0]!.config).toContain('search_path=pg_catalog, public')

    const privateFunctions = await getPool().query<{ name: string; can_execute: boolean }>(
      `SELECT p.proname AS name,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'guard_transaction_categorization_pointer',
           'categorization_snapshot_lines_match'
         )
       ORDER BY p.proname`,
    )
    expect(privateFunctions.rows).toEqual([
      { name: 'categorization_snapshot_lines_match', can_execute: false },
      { name: 'guard_transaction_categorization_pointer', can_execute: false },
    ])
  })
})
