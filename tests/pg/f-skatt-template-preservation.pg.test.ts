import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')
}

const prelude = migration('20260810115959_preserve_custom_2012_templates.sql')
const imported = migration('20260810120000_f_skatt_ef_template_2013.sql')
const restore = migration('20260810130500_restore_custom_2012_templates.sql')
const repair = migration('20260810131000_guarded_f_skatt_ef_2013.sql')

const systemTemplateWhere = `
  is_system = true
  AND company_id IS NULL
  AND team_id IS NULL
  AND pack_slug = 'preliminar-f-skatt-ef'
  AND name = 'Preliminär F-skatt (EF)'
  AND entity_type = 'enskild_firma'
`

const systemRuleWhere = `
  company_id IS NULL
  AND pattern = 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt'
`

function splitPreludeTransaction(): { capture: string; installFence: string } {
  const fenceMarker = '-- SECURITY INVOKER is deliberate.'
  const transactionMatch = prelude.match(/(?:^|\n)BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/)

  if (!transactionMatch) {
    throw new Error('preservation prelude must own one explicit transaction')
  }

  const body = transactionMatch[1]
  const markerIndex = body.indexOf(fenceMarker)
  if (markerIndex < 0) {
    throw new Error('preservation prelude fence marker is missing')
  }

  return {
    capture: body.slice(0, markerIndex),
    installFence: body.slice(markerIndex),
  }
}

async function runStandalone(sql: string): Promise<void> {
  await getPool().query(sql)
}

async function seedSystemPreState(): Promise<void> {
  await getPool().query(
    `UPDATE public.booking_template_library
        SET lines = jsonb_set(lines, '{0,account}', '"2012"'::jsonb)
      WHERE ${systemTemplateWhere}`,
  )
  await getPool().query(
    `UPDATE public.skattekonto_rules
        SET counter_account_ef = '2012'
      WHERE ${systemRuleWhere}`,
  )
}

async function forceExpectedSystemState(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE public.booking_template_library
        SET lines = (
          SELECT jsonb_agg(
            CASE
              WHEN line->>'account' = '2012'
                THEN jsonb_set(line, '{account}', '"2013"'::jsonb)
              ELSE line
            END
            ORDER BY ord
          )
          FROM jsonb_array_elements(lines) WITH ORDINALITY AS item(line, ord)
        )
      WHERE ${systemTemplateWhere}
        AND lines @> '[{"account":"2012"}]'::jsonb`,
  )
  await client.query(
    `UPDATE public.skattekonto_rules
        SET counter_account_ef = '2013'
      WHERE ${systemRuleWhere}`,
  )
}

async function cleanupTestState(params: {
  userId: string
  companyId: string
  templateIds: string[]
}): Promise<void> {
  const client = await getClient()
  const errors: unknown[] = []
  const attempt = async (sql: string, values?: unknown[]) => {
    try {
      await client.query(sql, values)
    } catch (error) {
      errors.push(error)
    }
  }

  try {
    await attempt('ROLLBACK')
    await attempt('RESET ROLE')
    await attempt(
      'DROP TRIGGER IF EXISTS btl_custom_2012_write_fence ON public.booking_template_library',
    )
    await attempt('DROP FUNCTION IF EXISTS public.fence_custom_2012_templates()')
    await attempt('DROP TABLE IF EXISTS public._btl_custom_2012_preservation')
    await attempt('ALTER TABLE public.booking_template_library ENABLE TRIGGER btl_updated_at')
    await attempt('ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_no_update')
    await attempt('ALTER TABLE public.audit_log DISABLE TRIGGER audit_log_no_delete')
    await forceExpectedSystemState(client).catch((error) => errors.push(error))
    await attempt('DELETE FROM public.booking_template_library WHERE id = ANY($1::uuid[])', [
      params.templateIds,
    ])
    await attempt('DELETE FROM public.fiscal_periods WHERE company_id = $1', [params.companyId])
    await attempt('DELETE FROM public.company_members WHERE company_id = $1', [params.companyId])
    await attempt('DELETE FROM public.companies WHERE id = $1', [params.companyId])
    await attempt('DELETE FROM auth.users WHERE id = $1', [params.userId])
    await attempt('ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_no_update')
    await attempt('ALTER TABLE public.audit_log ENABLE TRIGGER audit_log_no_delete')
  } finally {
    client.release()
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'F-skatt preservation test cleanup failed')
  }
}

async function assertAuthenticatedDmlIsFenced(params: {
  userId: string
  companyId: string
  customId: string
}): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true),
              set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify({ sub: params.userId, role: 'authenticated' }), params.userId],
    )
    await client.query('SET LOCAL ROLE authenticated')

    await client.query('SAVEPOINT denied_update')
    await expect(
      client.query(
        `UPDATE public.booking_template_library
            SET description = 'Attempt during preservation'
          WHERE id = $1`,
        [params.customId],
      ),
    ).rejects.toThrow(/fenced|snapshot|permission denied/i)
    await client.query('ROLLBACK TO SAVEPOINT denied_update')

    await client.query('SAVEPOINT denied_insert')
    await expect(
      client.query(
        `INSERT INTO public.booking_template_library
           (company_id, created_by, name, description, category, entity_type,
            lines, is_system)
         VALUES ($1, $2, 'New 2012 template', 'Must be blocked', 'other',
                 'enskild_firma',
                 '[{"account":"2012","side":"debit","type":"business","ratio":1}]'::jsonb,
                 false)`,
        [params.companyId, params.userId],
      ),
    ).rejects.toThrow(/fenced|permission denied/i)
    await client.query('ROLLBACK TO SAVEPOINT denied_insert')

    await client.query('SAVEPOINT denied_delete')
    await expect(
      client.query('DELETE FROM public.booking_template_library WHERE id = $1', [params.customId]),
    ).rejects.toThrow(/fenced|permission denied/i)
    await client.query('ROLLBACK TO SAVEPOINT denied_delete')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function waitForBlockedTemplateWriter(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = await getPool().query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE pid = $1
           AND relation = 'public.booking_template_library'::regclass
           AND mode = 'RowExclusiveLock'
           AND NOT granted
       ) AS waiting`,
      [pid],
    )
    if (blocked.rows[0].waiting) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('application writer did not block behind the preservation lock')
}

async function preservationArtifacts(): Promise<{ helper: string | null; fence: boolean }> {
  const result = await getPool().query<{ helper: string | null; fence: boolean }>(`
    SELECT
      to_regclass('public._btl_custom_2012_preservation')::text AS helper,
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'public.booking_template_library'::regclass
          AND tgname = 'btl_custom_2012_write_fence'
          AND NOT tgisinternal
      ) AS fence
  `)
  return result.rows[0]
}

describe('F-skatt EF migration replay', () => {
  it('runs the standalone migration sequence and preserves custom template bytes', async () => {
    const { companyId, userId } = await seedCompany()
    const customId = randomUUID()
    const unrelatedId = randomUUID()
    const customLines = [
      { account: '2012', label: 'Custom equity account', side: 'debit', type: 'business', ratio: 0.75 },
      { account: '1930', label: 'Bank', side: 'credit', type: 'settlement', ratio: 0.75 },
    ]

    try {
      await getPool().query(
        `INSERT INTO public.booking_template_library
           (id, company_id, created_by, name, description, category, entity_type,
            lines, is_system, updated_at)
         VALUES ($1, $2, $3, 'Custom 2012 template', 'Preserve exactly', 'other',
                 'enskild_firma', $4::jsonb, false, '2025-01-02T03:04:05Z'),
                ($5, $2, $3, 'Unrelated 2013 template', 'Unchanged', 'other',
                 'enskild_firma',
                 '[{"account":"2013","label":"Already correct","side":"debit","type":"business","ratio":1}]'::jsonb,
                 false, '2025-02-03T04:05:06Z')`,
        [customId, companyId, userId, JSON.stringify(customLines), unrelatedId],
      )
      await seedSystemPreState()

      const before = await getPool().query<{ row: string }>(
        `SELECT to_jsonb(template)::text AS row
           FROM public.booking_template_library template
          WHERE id = $1`,
        [customId],
      )
      const unrelatedBefore = await getPool().query<{ row: string }>(
        `SELECT to_jsonb(template)::text AS row
           FROM public.booking_template_library template
          WHERE id = $1`,
        [unrelatedId],
      )

      await runStandalone(prelude)
      expect(await preservationArtifacts()).toEqual({
        helper: '_btl_custom_2012_preservation',
        fence: true,
      })
      await assertAuthenticatedDmlIsFenced({ userId, companyId, customId })

      await runStandalone(imported)
      await runStandalone(restore)
      await runStandalone(repair)

      const after = await getPool().query<{ row: string }>(
        `SELECT to_jsonb(template)::text AS row
           FROM public.booking_template_library template
          WHERE id = $1`,
        [customId],
      )
      expect(after.rows[0]).toEqual(before.rows[0])

      const unrelatedAfter = await getPool().query<{ row: string }>(
        `SELECT to_jsonb(template)::text AS row
           FROM public.booking_template_library template
          WHERE id = $1`,
        [unrelatedId],
      )
      expect(unrelatedAfter.rows[0]).toEqual(unrelatedBefore.rows[0])

      const systemTemplate = await getPool().query<{ lines: Array<{ account: string }> }>(
        `SELECT lines
           FROM public.booking_template_library
          WHERE ${systemTemplateWhere}`,
      )
      expect(systemTemplate.rows).toHaveLength(1)
      expect(systemTemplate.rows[0].lines.some((line) => line.account === '2013')).toBe(true)
      expect(systemTemplate.rows[0].lines.some((line) => line.account === '2012')).toBe(false)

      const systemRule = await getPool().query<{ counter_account_ef: string }>(
        `SELECT counter_account_ef
           FROM public.skattekonto_rules
          WHERE ${systemRuleWhere}`,
      )
      expect(systemRule.rows).toEqual([{ counter_account_ef: '2013' }])
      expect(await preservationArtifacts()).toEqual({ helper: null, fence: false })

      for (const sql of [prelude, imported, restore, repair]) {
        await runStandalone(sql)
      }
      const afterReplay = await getPool().query<{ row: string }>(
        `SELECT to_jsonb(template)::text AS row
           FROM public.booking_template_library template
          WHERE id = $1`,
        [customId],
      )
      expect(afterReplay.rows[0]).toEqual(before.rows[0])
      expect(await preservationArtifacts()).toEqual({ helper: null, fence: false })

      const userClient = await getClient()
      try {
        await userClient.query('BEGIN')
        await userClient.query(
          `SELECT set_config('request.jwt.claims', $1, true),
                  set_config('request.jwt.claim.sub', $2, true)`,
          [JSON.stringify({ sub: userId, role: 'authenticated' }), userId],
        )
        await userClient.query('SET LOCAL ROLE authenticated')
        const edited = await userClient.query<{ description: string }>(
          `UPDATE public.booking_template_library
              SET description = 'Editable after restore'
            WHERE id = $1
          RETURNING description`,
          [customId],
        )
        expect(edited.rows).toEqual([{ description: 'Editable after restore' }])
      } finally {
        await userClient.query('ROLLBACK').catch(() => {})
        userClient.release()
      }
    } finally {
      await cleanupTestState({ userId, companyId, templateIds: [customId, unrelatedId] })
    }
  })

  it('fails closed on privileged drift and remains retryable', async () => {
    const { companyId, userId } = await seedCompany()
    const customId = randomUUID()

    try {
      await getPool().query(
        `INSERT INTO public.booking_template_library
           (id, company_id, created_by, name, description, category, entity_type,
            lines, is_system, updated_at)
         VALUES ($1, $2, $3, 'Drift check', 'Original', 'other',
                 'enskild_firma',
                 '[{"account":"2012","label":"Original","side":"debit","type":"business","ratio":1}]'::jsonb,
                 false, '2025-01-02T03:04:05Z')`,
        [customId, companyId, userId],
      )

      await runStandalone(prelude)
      await runStandalone(imported)

      await getPool().query(
        'ALTER TABLE public.booking_template_library DISABLE TRIGGER btl_custom_2012_write_fence',
      )
      try {
        await getPool().query(
          `UPDATE public.booking_template_library
              SET lines = jsonb_set(lines, '{0,label}', '"Privileged drift"')
            WHERE id = $1`,
          [customId],
        )
      } finally {
        await getPool().query(
          'ALTER TABLE public.booking_template_library ENABLE TRIGGER btl_custom_2012_write_fence',
        )
      }

      await expect(runStandalone(restore)).rejects.toThrow(/drifted/i)
      expect(await preservationArtifacts()).toEqual({
        helper: '_btl_custom_2012_preservation',
        fence: true,
      })

      const drifted = await getPool().query<{ label: string }>(
        `SELECT lines->0->>'label' AS label
           FROM public.booking_template_library
          WHERE id = $1`,
        [customId],
      )
      expect(drifted.rows).toEqual([{ label: 'Privileged drift' }])

      await getPool().query(
        'ALTER TABLE public.booking_template_library DISABLE TRIGGER btl_custom_2012_write_fence',
      )
      try {
        await getPool().query(
          `UPDATE public.booking_template_library template
              SET lines = preservation.expected_imported_lines,
                  updated_at = preservation.original_updated_at
             FROM public._btl_custom_2012_preservation preservation
            WHERE template.id = preservation.template_id
              AND template.id = $1`,
          [customId],
        )
      } finally {
        await getPool().query(
          'ALTER TABLE public.booking_template_library ENABLE TRIGGER btl_custom_2012_write_fence',
        )
      }

      await runStandalone(restore)
      await runStandalone(repair)
      expect(await preservationArtifacts()).toEqual({ helper: null, fence: false })

      const restored = await getPool().query<{ label: string; account: string }>(
        `SELECT lines->0->>'label' AS label, lines->0->>'account' AS account
           FROM public.booking_template_library
          WHERE id = $1`,
        [customId],
      )
      expect(restored.rows).toEqual([{ label: 'Original', account: '2012' }])
    } finally {
      await cleanupTestState({ userId, companyId, templateIds: [customId] })
    }
  })

  it('holds capture atomically against a concurrent authenticated writer', async () => {
    const { companyId, userId } = await seedCompany()
    const customId = randomUUID()
    const transaction = splitPreludeTransaction()
    const migrator = await getClient()
    const writer = await getClient()
    let writerOutcome: unknown
    let writerCompletion: Promise<void> | null = null

    try {
      await getPool().query(
        `INSERT INTO public.booking_template_library
           (id, company_id, created_by, name, description, category, entity_type,
            lines, is_system, updated_at)
         VALUES ($1, $2, $3, 'Concurrent 2012', 'Original', 'other',
                 'enskild_firma',
                 '[{"account":"2012","label":"Original","side":"debit","type":"business","ratio":1}]'::jsonb,
                 false, '2025-01-02T03:04:05Z')`,
        [customId, companyId, userId],
      )

      await migrator.query('BEGIN')
      await migrator.query(transaction.capture)

      const heldLock = await migrator.query<{ held: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND relation = 'public.booking_template_library'::regclass
            AND mode = 'ShareRowExclusiveLock'
            AND granted
        ) AS held
      `)
      expect(heldLock.rows[0].held).toBe(true)

      await writer.query('BEGIN')
      await writer.query(
        `SELECT set_config('request.jwt.claims', $1, true),
                set_config('request.jwt.claim.sub', $2, true)`,
        [JSON.stringify({ sub: userId, role: 'authenticated' }), userId],
      )
      await writer.query('SET LOCAL ROLE authenticated')
      const writerPid = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      writerCompletion = writer
        .query(
          `UPDATE public.booking_template_library
              SET description = 'Write in capture gap'
            WHERE id = $1`,
          [customId],
        )
        .then(
          () => {
            writerOutcome = 'updated'
          },
          (error: unknown) => {
            writerOutcome = error
          },
        )

      await waitForBlockedTemplateWriter(writerPid.rows[0].pid)
      expect(writerOutcome).toBeUndefined()

      await migrator.query(transaction.installFence)
      expect(writerOutcome).toBeUndefined()
      await migrator.query('COMMIT')

      await writerCompletion
      expect(writerOutcome).toBeInstanceOf(Error)
      expect((writerOutcome as Error).message).toMatch(/fenced|snapshot|permission denied/i)
      await writer.query('ROLLBACK')

      await runStandalone(imported)
      await runStandalone(restore)
      await runStandalone(repair)

      const restored = await getPool().query<{ description: string; account: string }>(
        `SELECT description, lines->0->>'account' AS account
           FROM public.booking_template_library
          WHERE id = $1`,
        [customId],
      )
      expect(restored.rows).toEqual([{ description: 'Original', account: '2012' }])
      expect(await preservationArtifacts()).toEqual({ helper: null, fence: false })
    } finally {
      await migrator.query('ROLLBACK').catch(() => {})
      if (writerCompletion) await writerCompletion.catch(() => {})
      await writer.query('ROLLBACK').catch(() => {})
      writer.release()
      migrator.release()
      await cleanupTestState({ userId, companyId, templateIds: [customId] })
    }
  })
})
