import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertTransaction, seedCompany } from './fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'

async function seedProposalTarget() {
  const company = await seedCompany()
  const transactionId = await insertTransaction({
    companyId: company.companyId,
    userId: company.userId,
    amount: -425,
  })
  const documentId = randomUUID()
  const inboxItemId = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes,
        storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'receipt.pdf', 'application/pdf', 100,
             $4, $5, 'mail_hunt')`,
    [
      documentId,
      company.userId,
      company.companyId,
      `documents/${company.companyId}/${documentId}.pdf`,
      documentId.replace(/-/g, '').padEnd(64, '0'),
    ],
  )
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items
       (id, company_id, user_id, source, status, document_id)
     VALUES ($1, $2, $3, 'mail_hunt', 'received', $4)`,
    [inboxItemId, company.companyId, company.userId, documentId],
  )
  return { ...company, transactionId, documentId, inboxItemId }
}

function proposal(target: Awaited<ReturnType<typeof seedProposalTarget>>, runId: string) {
  return [{
    company_id: target.companyId,
    user_id: target.userId,
    operation_type: 'attach_document_to_transaction',
    title: 'Koppla underlag: receipt.pdf till test',
    params: {
      transaction_id: target.transactionId,
      document_id: target.documentId,
    },
    preview_data: { will_overwrite_existing: false },
    actor_type: 'cron',
    actor_label: 'Kvittojakten',
    risk_level: 'medium',
    agent_metadata: {
      source: 'receipt_hunt',
      run_id: runId,
      inbox_item_id: target.inboxItemId,
      confidence: 0.99,
      match_reasons: ['Belopp matchar'],
    },
  }]
}

async function callRpc(
  client: PoolClient,
  target: Awaited<ReturnType<typeof seedProposalTarget>>,
  runId: string,
  deadline: Date,
  rows: unknown = proposal(target, runId),
) {
  return client.query<{ inserted: number }>(
    `SELECT public.stage_receipt_hunt_proposals($1, $2, $3, $4::jsonb) AS inserted`,
    [target.companyId, runId, deadline.toISOString(), JSON.stringify(rows)],
  )
}

async function pendingCount(companyId: string, runId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM public.pending_operations
     WHERE company_id = $1
       AND agent_metadata->>'run_id' = $2`,
    [companyId, runId],
  )
  return rows[0].count
}

describe('receipt-hunt deadline-bound staging RPC (pg)', () => {
  it('rejects a pre-expired deadline with zero pending rows', async () => {
    const target = await seedProposalTarget()
    const runId = randomUUID()

    await expect(runAsServiceRole((client) =>
      callRpc(client, target, runId, new Date(Date.now() - 1_000)),
    )).rejects.toThrow(/deadline/i)

    await expect(pendingCount(target.companyId, runId)).resolves.toBe(0)
  })

  it('rolls back when insert work crosses the deadline before the post-check', async () => {
    const target = await seedProposalTarget()
    const runId = randomUUID()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE FUNCTION public.test_delay_receipt_hunt_insert()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.05);
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER test_delay_receipt_hunt_insert
          BEFORE INSERT ON public.pending_operations
          FOR EACH ROW EXECUTE FUNCTION public.test_delay_receipt_hunt_insert();
      `)
      await client.query(
        `SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true),
                set_config('request.jwt.claim.role', 'service_role', true)`,
      )
      await client.query('SET LOCAL ROLE service_role')

      await expect(
        callRpc(client, target, runId, new Date(Date.now() + 20)),
      ).rejects.toThrow(/deadline/i)
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    await expect(pendingCount(target.companyId, runId)).resolves.toBe(0)
  })

  it('denies authenticated callers and grants only service_role execution', async () => {
    const target = await seedProposalTarget()
    const runId = randomUUID()

    await expect(withUserContext(target.userId, (client) =>
      callRpc(client, target, runId, new Date(Date.now() + 5_000)),
    )).rejects.toThrow(/permission denied|requires service_role/i)

    const { rows } = await getPool().query<{
      public_exec: boolean
      anon_exec: boolean
      authenticated_exec: boolean
      service_exec: boolean
    }>(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_proc function_row
          CROSS JOIN LATERAL aclexplode(function_row.proacl) privilege
          WHERE function_row.oid = 'public.stage_receipt_hunt_proposals(uuid,text,timestamptz,jsonb)'::regprocedure
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'
        ) AS public_exec,
        has_function_privilege('anon', 'public.stage_receipt_hunt_proposals(uuid,text,timestamptz,jsonb)', 'EXECUTE') AS anon_exec,
        has_function_privilege('authenticated', 'public.stage_receipt_hunt_proposals(uuid,text,timestamptz,jsonb)', 'EXECUTE') AS authenticated_exec,
        has_function_privilege('service_role', 'public.stage_receipt_hunt_proposals(uuid,text,timestamptz,jsonb)', 'EXECUTE') AS service_exec
    `)
    expect(rows[0]).toEqual({
      public_exec: false,
      anon_exec: false,
      authenticated_exec: false,
      service_exec: true,
    })
  })

  it('denies cross-company and malformed proposal rows', async () => {
    const first = await seedProposalTarget()
    const second = await seedProposalTarget()
    const crossRunId = randomUUID()
    const crossRows = proposal(first, crossRunId)
    crossRows[0].company_id = second.companyId

    await expect(runAsServiceRole((client) =>
      callRpc(client, second, crossRunId, new Date(Date.now() + 5_000), crossRows),
    )).rejects.toThrow(/crosses company|ineligible/i)

    const malformedRunId = randomUUID()
    const malformed = proposal(first, malformedRunId) as Array<Record<string, unknown>>
    malformed[0].risk_level = 'low'
    await expect(runAsServiceRole((client) =>
      callRpc(client, first, malformedRunId, new Date(Date.now() + 5_000), malformed),
    )).rejects.toThrow(/identity is invalid/i)
    await expect(pendingCount(first.companyId, malformedRunId)).resolves.toBe(0)
  })

  it('is idempotent for an exact retry', async () => {
    const target = await seedProposalTarget()
    const runId = randomUUID()
    const deadline = new Date(Date.now() + 5_000)

    const first = await runAsServiceRole((client) => callRpc(client, target, runId, deadline))
    const second = await runAsServiceRole((client) => callRpc(client, target, runId, deadline))

    expect(first.rows[0].inserted).toBe(1)
    expect(second.rows[0].inserted).toBe(0)
    await expect(pendingCount(target.companyId, runId)).resolves.toBe(1)
  })
})
