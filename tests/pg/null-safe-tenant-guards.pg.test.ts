import { afterAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

/**
 * NULL-safe tenant guards (mcp_optimization_plan P2-3 / PR #872 review):
 * `x NOT IN (SELECT public.user_company_ids())` skips the deny branch on
 * UNKNOWN. Migration 20260703180000 introduces caller_is_company_member()
 * and mechanically rewrites every public function carrying the raw pattern.
 *
 * The ratchet below runs after full migration replay in CI, so it both
 * proves the rewrite worked and permanently blocks the pattern from
 * returning in future migrations.
 */

const RAW_PATTERN = '%NOT IN (SELECT public.user_company_ids())%'

async function functionsWithRawPattern(): Promise<string[]> {
  const { rows } = await getPool().query<{ proname: string }>(
    `SELECT p.proname
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc LIKE $1
     ORDER BY p.proname`,
    [RAW_PATTERN],
  )
  return rows.map((r) => r.proname)
}

async function functionSource(name: string): Promise<string> {
  const { rows } = await getPool().query<{ prosrc: string }>(
    `SELECT p.prosrc
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  )
  expect(rows, `Expected one public function named ${name}`).toHaveLength(1)
  return rows[0].prosrc
}

describe('NULL-safe tenant guards', () => {
  afterAll(async () => {
    await getPool().query('DROP FUNCTION IF EXISTS public._ratchet_probe_raw_guard(uuid)')
  })

  it('ratchet: no public function carries the raw NOT IN guard pattern', async () => {
    const offenders = await functionsWithRawPattern()
    expect(
      offenders,
      `Functions still using the NULL-unsafe guard: use public.caller_is_company_member() instead:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('the ratchet detector actually catches the pattern (test the test)', async () => {
    await getPool().query(`
      CREATE OR REPLACE FUNCTION public._ratchet_probe_raw_guard(p_company_id uuid)
      RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF p_company_id NOT IN (SELECT public.user_company_ids()) THEN
          RETURN false;
        END IF;
        RETURN true;
      END;
      $$`)
    const offenders = await functionsWithRawPattern()
    expect(offenders).toContain('_ratchet_probe_raw_guard')
    await getPool().query('DROP FUNCTION public._ratchet_probe_raw_guard(uuid)')
  })

  it.each([
    ['attach_transaction_categorization', 'RETURN false;'],
    [
      'compensate_transaction_categorization',
      "RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id",
    ],
  ])('%s uses the canonical nested writable-role guard', async (name, denial) => {
    const source = await functionSource(name)
    expect(source).toMatch(
      new RegExp(
        `IF v_jwt_role IN \\('anon', 'authenticated'\\) THEN\\s+` +
          `IF NOT public\\.caller_can_write_company\\(p_company_id\\) THEN\\s+` +
          denial.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    )
  })

  it('caller_is_company_member: member true, foreigner false, NULL always false', async () => {
    const { userId, companyId } = await seedCompany()
    const strangerId = await insertAuthUser()

    const asUser = async (uid: string, company: string | null) =>
      withUserContext(uid, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          `SELECT public.caller_is_company_member($1) AS ok`,
          [company],
        )
        return rows[0].ok
      })

    expect(await asUser(userId, companyId)).toBe(true)
    expect(await asUser(strangerId, companyId)).toBe(false)
    expect(await asUser(userId, null)).toBe(false)
  })

  it('caller_can_write_company: writable roles true, viewer/foreigner/cross-company/NULL false', async () => {
    const owner = await seedCompany()
    const other = await seedCompany()
    const adminId = await insertAuthUser()
    const memberId = await insertAuthUser()
    const viewerId = await insertAuthUser()
    const strangerId = await insertAuthUser()
    await insertCompanyMember({
      companyId: owner.companyId,
      userId: adminId,
      role: 'admin',
    })
    await insertCompanyMember({
      companyId: owner.companyId,
      userId: memberId,
      role: 'member',
    })
    await insertCompanyMember({
      companyId: owner.companyId,
      userId: viewerId,
      role: 'viewer',
    })

    const asUser = async (uid: string, company: string | null) =>
      withUserContext(uid, async (client) => {
        const { rows } = await client.query<{ ok: boolean }>(
          `SELECT public.caller_can_write_company($1) AS ok`,
          [company],
        )
        return rows[0].ok
      })

    expect(await asUser(owner.userId, owner.companyId)).toBe(true)
    expect(await asUser(adminId, owner.companyId)).toBe(true)
    expect(await asUser(memberId, owner.companyId)).toBe(true)
    expect(await asUser(viewerId, owner.companyId)).toBe(false)
    expect(await asUser(strangerId, owner.companyId)).toBe(false)
    expect(await asUser(other.userId, owner.companyId)).toBe(false)
    expect(await asUser(owner.userId, null)).toBe(false)
  })
})
