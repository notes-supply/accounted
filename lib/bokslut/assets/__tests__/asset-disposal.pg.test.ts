import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('commit_asset_disposal (pg-real)', () => {
  async function insertAsset(
    userId: string,
    companyId: string,
    acquisitionCost = 100_000,
  ): Promise<string> {
    const assetId = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets (
         id, user_id, company_id, name, category, acquisition_date,
         acquisition_cost, salvage_value, useful_life_months,
         depreciation_method, bas_asset_account, bas_accumulated_account,
         bas_expense_account
       ) VALUES ($1, $2, $3, 'Machine', 'equipment', '2025-01-01',
                 $4, 0, 60, 'linear', '1220', '1229', '7832')`,
      [assetId, userId, companyId, acquisitionCost],
    )
    return assetId
  }

  async function insertDraft(args: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    debitLines: Array<[string, number]>
    creditLines: Array<[string, number]>
  }): Promise<string> {
    const entryId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries (
         id, user_id, company_id, fiscal_period_id, voucher_number,
         voucher_series, entry_date, description, source_type, status
       ) VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-30',
                 'Asset disposal', 'system', 'draft')`,
      [entryId, args.userId, args.companyId, args.fiscalPeriodId],
    )
    for (const [account, amount] of args.debitLines) {
      await getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 0)`,
        [entryId, account, amount],
      )
    }
    for (const [account, amount] of args.creditLines) {
      await getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, 0, $3)`,
        [entryId, account, amount],
      )
    }
    return entryId
  }

  type CommitArgs = {
    companyId: string
    assetId: string
    entryId: string | null
    fiscalPeriodId: string
    disposalType?: string
    disposedProceeds?: number
    currentDepreciation?: number
    expectedUpdatedAt?: string
  }

  async function commitWithClient(client: PoolClient, args: CommitArgs) {
    const version = args.expectedUpdatedAt ?? (
      await client.query<{ updated_at: string }>(
        `SELECT updated_at::text FROM public.assets WHERE id = $1`,
        [args.assetId],
      )
    ).rows[0]!.updated_at
    return client.query<{ voucher_number: number | null }>(
      `SELECT * FROM public.commit_asset_disposal(
         $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid, $6::text,
         '2026-06-30'::date, $7::numeric, 0::numeric, 'exempt'::text,
         $8::numeric, 0::numeric, 'none'::text, 4::integer, 5::integer,
         0::numeric, 0::numeric, 0::numeric, NULL::text, NULL::text
       )`,
      [
        args.companyId,
        args.assetId,
        args.entryId,
        version,
        args.fiscalPeriodId,
        args.disposalType ?? 'sale',
        args.disposedProceeds ?? 80_000,
        args.currentDepreciation ?? 0,
      ],
    )
  }

  async function commit(args: CommitArgs) {
    return runAsServiceRole((client) => commitWithClient(client, args))
  }

  it('posts the voucher, schedule, and register state in one transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['7832', 10_000], ['1229', 30_000], ['1930', 80_000]],
      creditLines: [['1229', 10_000], ['1220', 100_000], ['3973', 10_000]],
    })

    const committed = await commit({
      companyId,
      assetId,
      entryId,
      fiscalPeriodId,
      currentDepreciation: 10_000,
    })

    const entry = await getPool().query(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    const asset = await getPool().query(
      `SELECT disposed_at::text, disposal_type, disposal_journal_entry_id
         FROM public.assets WHERE id = $1`,
      [assetId],
    )
    const schedule = await getPool().query(
      `SELECT planned_depreciation::numeric, journal_entry_id
         FROM public.depreciation_schedules
        WHERE asset_id = $1 AND fiscal_period_id = $2`,
      [assetId, fiscalPeriodId],
    )

    expect(entry.rows[0]).toMatchObject({ status: 'posted' })
    expect(entry.rows[0].voucher_number).toBeGreaterThan(0)
    expect(committed.rows).toEqual([{ voucher_number: entry.rows[0].voucher_number }])
    expect(asset.rows[0]).toMatchObject({
      disposed_at: '2026-06-30',
      disposal_type: 'sale',
      disposal_journal_entry_id: entryId,
    })
    expect(Number(schedule.rows[0].planned_depreciation)).toBe(10_000)
    expect(schedule.rows[0].journal_entry_id).toBe(entryId)

    await expect(
      getPool().query(`UPDATE public.assets SET disposed_proceeds = 1 WHERE id = $1`, [assetId]),
    ).rejects.toThrow(/Cannot modify financial or disposal attributes/)

    await expect(
      getPool().query(`UPDATE public.assets SET notes = 'Audit note' WHERE id = $1`, [assetId]),
    ).resolves.toBeDefined()
  })

  it('rolls back the voucher, sequence, schedule, command, and register on a late database failure', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['7832', 10_000], ['1229', 30_000], ['1930', 80_000]],
      creditLines: [['1229', 10_000], ['1220', 100_000], ['3973', 10_000]],
    })
    const version = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.assets WHERE id = $1`,
      [assetId],
    )
    const sequenceBefore = await getPool().query(
      `SELECT voucher_series, last_number
         FROM public.voucher_sequences
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    const assetBefore = await getPool().query(
      `SELECT to_jsonb(asset) AS asset_row
         FROM public.assets asset
        WHERE asset.id = $1`,
      [assetId],
    )
    const client = await getClient()

    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE FUNCTION public.test_fail_late_asset_disposal_update()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          IF OLD.disposed_at IS NULL AND NEW.disposed_at IS NOT NULL THEN
            IF NOT EXISTS (
              SELECT 1
              FROM public.journal_entries entry
              JOIN public.voucher_sequences sequence
                ON sequence.company_id = entry.company_id
               AND sequence.fiscal_period_id = entry.fiscal_period_id
               AND sequence.voucher_series = entry.voucher_series
               AND sequence.last_number >= entry.voucher_number
              WHERE entry.id = NEW.disposal_journal_entry_id
                AND entry.company_id = NEW.company_id
                AND entry.status = 'posted'
            ) OR NOT EXISTS (
              SELECT 1
              FROM public.depreciation_schedules schedule
              WHERE schedule.asset_id = NEW.id
                AND schedule.company_id = NEW.company_id
                AND schedule.journal_entry_id = NEW.disposal_journal_entry_id
            ) OR NOT EXISTS (
              SELECT 1
              FROM accounting_private.asset_disposal_commands command
              WHERE command.company_id = NEW.company_id
                AND command.asset_id = NEW.id
                AND command.prepared_journal_entry_id = NEW.disposal_journal_entry_id
            ) THEN
              RAISE EXCEPTION 'late asset disposal failure preconditions were not reached';
            END IF;
            RAISE EXCEPTION 'forced late asset disposal register failure';
          END IF;
          RETURN NEW;
        END;
        $trigger$
      `)
      await client.query(`
        CREATE TRIGGER zz_test_fail_late_asset_disposal_update
        BEFORE UPDATE ON public.assets
        FOR EACH ROW
        EXECUTE FUNCTION public.test_fail_late_asset_disposal_update()
      `)
      await client.query(
        `SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`,
      )
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'service_role', true)`,
      )
      await client.query('SET LOCAL ROLE service_role')
      await client.query('SAVEPOINT before_asset_disposal')

      await expect(
        commitWithClient(client, {
          companyId,
          assetId,
          entryId,
          fiscalPeriodId,
          currentDepreciation: 10_000,
          expectedUpdatedAt: version.rows[0]!.updated_at,
        }),
      ).rejects.toThrow(/forced late asset disposal register failure/)

      await client.query('ROLLBACK TO SAVEPOINT before_asset_disposal')
      await client.query('RESET ROLE')

      const state = await client.query<{
        status: string
        voucher_number: number
        disposed_at: string | null
        disposed_proceeds: string | null
        disposed_proceeds_vat: string | null
        disposed_vat_treatment: string | null
        disposal_type: string | null
        disposal_journal_entry_id: string | null
        jamkning_amount: string | null
        jamkning_direction: string | null
        jamkning_remaining_years: number | null
        jamkning_total_years: number | null
        asset_updated_at: string
        schedule_count: number
        command_count: number
        capability_active: boolean
      }>(
        `SELECT entry.status,
                entry.voucher_number,
                asset.disposed_at::text,
                asset.disposed_proceeds::text,
                asset.disposed_proceeds_vat::text,
                asset.disposed_vat_treatment,
                asset.disposal_type,
                asset.disposal_journal_entry_id,
                asset.jamkning_amount::text,
                asset.jamkning_direction,
                asset.jamkning_remaining_years,
                asset.jamkning_total_years,
                asset.updated_at::text AS asset_updated_at,
                (
                  SELECT count(*)::int
                  FROM public.depreciation_schedules schedule
                  WHERE schedule.asset_id = asset.id
                    AND schedule.fiscal_period_id = $3
                ) AS schedule_count,
                (
                  SELECT count(*)::int
                  FROM accounting_private.asset_disposal_commands command
                  WHERE command.company_id = $2
                    AND command.asset_id = asset.id
                ) AS command_count,
                accounting_private.has_accounting_command_capability(
                  'asset_disposal_transition', $2::uuid, asset.id
                ) AS capability_active
           FROM public.journal_entries entry
           JOIN public.assets asset ON asset.id = $4
          WHERE entry.id = $1`,
        [entryId, companyId, fiscalPeriodId, assetId],
      )
      const sequenceAfter = await client.query(
        `SELECT voucher_series, last_number
           FROM public.voucher_sequences
          WHERE company_id = $1
            AND fiscal_period_id = $2
            AND voucher_series = 'A'`,
        [companyId, fiscalPeriodId],
      )
      const assetAfter = await client.query(
        `SELECT to_jsonb(asset) AS asset_row
           FROM public.assets asset
          WHERE asset.id = $1`,
        [assetId],
      )

      expect(state.rows[0]).toEqual({
        status: 'draft',
        voucher_number: 0,
        disposed_at: null,
        disposed_proceeds: null,
        disposed_proceeds_vat: '0.00',
        disposed_vat_treatment: null,
        disposal_type: null,
        disposal_journal_entry_id: null,
        jamkning_amount: '0.00',
        jamkning_direction: null,
        jamkning_remaining_years: null,
        jamkning_total_years: null,
        asset_updated_at: version.rows[0]!.updated_at,
        schedule_count: 0,
        command_count: 0,
        capability_active: false,
      })
      expect(sequenceAfter.rows).toEqual(sequenceBefore.rows)
      expect(assetAfter.rows).toEqual(assetBefore.rows)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('recovers an exact response-loss retry without duplicating durable state and rejects conflicts', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['7832', 10_000], ['1229', 30_000], ['1930', 80_000]],
      creditLines: [['1229', 10_000], ['1220', 100_000], ['3973', 10_000]],
    })
    const version = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.assets WHERE id = $1`,
      [assetId],
    )
    const command = {
      companyId,
      assetId,
      entryId,
      fiscalPeriodId,
      currentDepreciation: 10_000,
      expectedUpdatedAt: version.rows[0]!.updated_at,
    }

    await commit(command)

    const readState = () => getPool().query<{
      status: string
      voucher_number: number
      voucher_series: string
      sequence_number: number
      asset_updated_at: string
      asset_row: Record<string, unknown>
      posted_entry_count: number
      schedule_rows: Array<Record<string, unknown>>
      command_row: Record<string, unknown>
      command_version_matches: boolean
    }>(
      `SELECT entry.status,
              entry.voucher_number,
              entry.voucher_series,
              sequence.last_number AS sequence_number,
              asset.updated_at::text AS asset_updated_at,
              to_jsonb(asset) AS asset_row,
              (
                SELECT count(*)::int
                FROM public.journal_entries company_entry
                WHERE company_entry.company_id = $2
                  AND company_entry.status = 'posted'
              ) AS posted_entry_count,
              (
                SELECT jsonb_agg(to_jsonb(schedule) ORDER BY schedule.id)
                FROM public.depreciation_schedules schedule
                WHERE schedule.asset_id = asset.id
                  AND schedule.fiscal_period_id = $3
              ) AS schedule_rows,
              (
                SELECT to_jsonb(command)
                FROM accounting_private.asset_disposal_commands command
                WHERE command.company_id = $2
                  AND command.asset_id = asset.id
              ) AS command_row,
              (
                SELECT command.expected_asset_updated_at IS NOT DISTINCT FROM $5::timestamptz
                FROM accounting_private.asset_disposal_commands command
                WHERE command.company_id = $2
                  AND command.asset_id = asset.id
              ) AS command_version_matches
         FROM public.journal_entries entry
         JOIN public.assets asset ON asset.id = $4
         JOIN public.voucher_sequences sequence
           ON sequence.company_id = $2
          AND sequence.fiscal_period_id = $3
          AND sequence.voucher_series = entry.voucher_series
        WHERE entry.id = $1`,
      [entryId, companyId, fiscalPeriodId, assetId, version.rows[0]!.updated_at],
    )
    const afterFirst = await readState()
    const retry = await commit(command)
    const afterRetry = await readState()

    expect(retry.rows).toEqual([{
      voucher_number: afterFirst.rows[0]!.voucher_number,
    }])
    expect(afterRetry.rows).toEqual(afterFirst.rows)
    expect(afterRetry.rows[0]!.schedule_rows).toHaveLength(1)
    expect(afterRetry.rows[0]!.command_version_matches).toBe(true)
    expect(afterRetry.rows[0]!.command_row).toMatchObject({
      company_id: companyId,
      asset_id: assetId,
      prepared_journal_entry_id: entryId,
      fiscal_period_id: fiscalPeriodId,
      disposal_type: 'sale',
      disposed_at: '2026-06-30',
      disposed_proceeds: 80_000,
      proceeds_vat: 0,
      vat_treatment: 'exempt',
      current_depreciation: 10_000,
      jamkning_amount: 0,
      jamkning_direction: 'none',
      jamkning_remaining_years: 4,
      jamkning_total_years: 5,
      jamkning_original_input_vat: 0,
      jamkning_original_deduction_percent: 0,
      jamkning_new_deduction_percent: 0,
      actor_type: null,
      actor_label: null,
      voucher_number: afterFirst.rows[0]!.voucher_number,
      voucher_series: 'A',
    })

    await expect(
      commit({ ...command, disposalType: 'business_transfer' }),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Stored asset disposal command conflicts with supplied identity or retained state',
    })

    const conflictingEntryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['1930', 80_000], ['7973', 20_000]],
      creditLines: [['1220', 100_000]],
    })
    await expect(
      commit({ ...command, entryId: conflictingEntryId }),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Stored asset disposal command conflicts with supplied identity or retained state',
    })

    await expect(
      getPool().query(
        `UPDATE accounting_private.asset_disposal_commands
            SET actor_label = 'forged'
          WHERE company_id = $1 AND asset_id = $2`,
        [companyId, assetId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Asset disposal command identity is immutable',
    })
    await expect(
      getPool().query(
        `DELETE FROM accounting_private.asset_disposal_commands
          WHERE company_id = $1 AND asset_id = $2`,
        [companyId, assetId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Asset disposal command identity is immutable',
    })

    const afterConflicts = await readState()
    const conflictingEntry = await getPool().query(
      `SELECT status, voucher_number
         FROM public.journal_entries
        WHERE id = $1`,
      [conflictingEntryId],
    )
    expect(afterConflicts.rows).toEqual(afterFirst.rows)
    expect(conflictingEntry.rows).toEqual([{ status: 'draft', voucher_number: 0 }])
  })

  it('returns the original null voucher identity on an exact no-voucher retry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId, 0)
    const version = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.assets WHERE id = $1`,
      [assetId],
    )
    const command = {
      companyId,
      assetId,
      entryId: null,
      fiscalPeriodId,
      disposedProceeds: 0,
      expectedUpdatedAt: version.rows[0]!.updated_at,
    }

    const first = await commit(command)
    const stateAfterFirst = await getPool().query(
      `SELECT asset.disposed_at::text,
              asset.disposal_journal_entry_id,
              asset.updated_at::text,
              command.prepared_journal_entry_id,
              command.voucher_number,
              command.voucher_series,
              (
                SELECT count(*)::int
                FROM public.depreciation_schedules schedule
                WHERE schedule.asset_id = asset.id
              ) AS schedule_count,
              (
                SELECT count(*)::int
                FROM public.journal_entries entry
                WHERE entry.company_id = $1
              ) AS entry_count
         FROM public.assets asset
         JOIN accounting_private.asset_disposal_commands command
           ON command.company_id = asset.company_id
          AND command.asset_id = asset.id
        WHERE asset.company_id = $1
          AND asset.id = $2`,
      [companyId, assetId],
    )
    const retry = await commit(command)
    const stateAfterRetry = await getPool().query(
      `SELECT asset.disposed_at::text,
              asset.disposal_journal_entry_id,
              asset.updated_at::text,
              command.prepared_journal_entry_id,
              command.voucher_number,
              command.voucher_series,
              (
                SELECT count(*)::int
                FROM public.depreciation_schedules schedule
                WHERE schedule.asset_id = asset.id
              ) AS schedule_count,
              (
                SELECT count(*)::int
                FROM public.journal_entries entry
                WHERE entry.company_id = $1
              ) AS entry_count
         FROM public.assets asset
         JOIN accounting_private.asset_disposal_commands command
           ON command.company_id = asset.company_id
          AND command.asset_id = asset.id
        WHERE asset.company_id = $1
          AND asset.id = $2`,
      [companyId, assetId],
    )

    expect(first.rows).toEqual([{ voucher_number: null }])
    expect(retry.rows).toEqual(first.rows)
    expect(stateAfterRetry.rows).toEqual(stateAfterFirst.rows)
    expect(stateAfterRetry.rows).toEqual([{
      disposed_at: '2026-06-30',
      disposal_journal_entry_id: null,
      updated_at: stateAfterFirst.rows[0]!.updated_at,
      prepared_journal_entry_id: null,
      voucher_number: null,
      voucher_series: null,
      schedule_count: 0,
      entry_count: stateAfterFirst.rows[0]!.entry_count,
    }])
  })

  it('rejects a forged accounted.asset_disposal GUC on a direct register transition', async () => {
    const { userId, companyId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)

    await expect(
      withUserContext(userId, async (client) => {
        await client.query(
          `SELECT set_config('accounted.asset_disposal', 'true', true)`,
        )
        await client.query(
          `UPDATE public.assets
              SET disposed_at = '2026-06-30',
                  disposal_type = 'sale'
            WHERE id = $1 AND company_id = $2`,
          [assetId, companyId],
        )
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: 'Asset disposal state may be set only through commit_asset_disposal',
    })

    const asset = await getPool().query(
      `SELECT disposed_at, disposal_type, disposal_journal_entry_id
         FROM public.assets
        WHERE id = $1`,
      [assetId],
    )
    expect(asset.rows).toEqual([{
      disposed_at: null,
      disposal_type: null,
      disposal_journal_entry_id: null,
    }])
  })

  it('rejects a stale asset version before posting the prepared draft', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['1930', 80_000], ['7973', 20_000]],
      creditLines: [['1220', 100_000]],
    })
    const version = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.assets WHERE id = $1`,
      [assetId],
    )
    await getPool().query(
      `UPDATE public.assets SET notes = 'concurrent planning change' WHERE id = $1`,
      [assetId],
    )

    await expect(
      commit({
        companyId,
        assetId,
        entryId,
        fiscalPeriodId,
        expectedUpdatedAt: version.rows[0]!.updated_at,
      }),
    ).rejects.toMatchObject({ code: '40001' })

    const state = await getPool().query<{
      entry_status: string
      voucher_number: number
      disposed_at: string | null
    }>(
      `SELECT entry.status AS entry_status, entry.voucher_number, asset.disposed_at::text
       FROM public.journal_entries entry
       JOIN public.assets asset ON asset.id = $2
       WHERE entry.id = $1`,
      [entryId, assetId],
    )
    expect(state.rows[0]).toEqual({
      entry_status: 'draft',
      voucher_number: 0,
      disposed_at: null,
    })
  })

  it('is service-only and removes the old unversioned signature', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['1930', 80_000], ['7973', 20_000]],
      creditLines: [['1220', 100_000]],
    })
    const version = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.assets WHERE id = $1`,
      [assetId],
    )

    await expect(
      withUserContext(userId, async (client) => {
        await client.query(
          `SELECT * FROM public.commit_asset_disposal(
             $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid, 'sale'::text,
             '2026-06-30'::date, 80000::numeric, 0::numeric, 'exempt'::text,
             0::numeric, 0::numeric, 'none'::text, 4::integer, 5::integer,
             0::numeric, 0::numeric, 0::numeric, NULL::text, NULL::text
           )`,
          [companyId, assetId, entryId, version.rows[0]!.updated_at, fiscalPeriodId],
        )
      }),
    ).rejects.toMatchObject({ code: '42501' })

    const signatures = await getPool().query<{
      arguments: string
      authenticated_exec: boolean
      service_exec: boolean
      public_exec: boolean
      security_definer: boolean
      config: string[] | null
    }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS arguments,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         p.prosecdef AS security_definer,
         p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'commit_asset_disposal'`,
    )
    expect(signatures.rows).toHaveLength(1)
    expect(signatures.rows[0]!.arguments).toContain('p_expected_asset_updated_at timestamp with time zone')
    expect(signatures.rows[0]).toMatchObject({
      authenticated_exec: false,
      service_exec: true,
      public_exec: false,
      security_definer: true,
    })
    expect(signatures.rows[0]!.config).toContain('search_path=pg_catalog, public')
  })

  it('blocks deletion after disposal while retaining cleanup of unused assets', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const disposedAssetId = await insertAsset(userId, companyId)
    const unusedAssetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['1930', 80_000], ['7973', 20_000]],
      creditLines: [['1220', 100_000]],
    })
    await commit({ companyId, assetId: disposedAssetId, entryId, fiscalPeriodId })

    await expect(
      getPool().query(`DELETE FROM public.assets WHERE id = $1`, [disposedAssetId]),
    ).rejects.toMatchObject({ code: '23514' })
    const deleted = await getPool().query(
      `DELETE FROM public.assets WHERE id = $1`,
      [unusedAssetId],
    )
    expect(deleted.rowCount).toBe(1)
  })
})
