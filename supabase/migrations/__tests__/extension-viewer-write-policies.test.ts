import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260809110000_extension_company_write_role_policies.sql',
  ),
  'utf8',
)

const writePolicies = [
  ['shopify_connections', 'members insert shopify_connections'],
  ['shopify_connections', 'members update shopify_connections'],
  ['woocommerce_connections', 'members insert woocommerce_connections'],
  ['woocommerce_connections', 'members update woocommerce_connections'],
  ['mileage_trips', 'insert own-company mileage_trips'],
  ['mileage_trips', 'update own-company mileage_trips'],
  ['mileage_trips', 'delete own-company mileage_trips'],
] as const

describe('extension company write-role policy migration', () => {
  it('convergently replaces exactly the seven vulnerable write policies', () => {
    for (const [table, policy] of writePolicies) {
      expect(migration).toContain(
        `DROP POLICY IF EXISTS "${policy}" ON public.${table};`,
      )
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${policy}"\\s+ON public\\.${table}`,
        ),
      )
    }

    expect(migration.match(/DROP POLICY IF EXISTS/g)).toHaveLength(7)
    expect(migration.match(/CREATE POLICY/g)).toHaveLength(7)
    expect(migration).not.toMatch(/DROP POLICY[^;]+read/i)
  })

  it('uses the exact active company and exact-company writable role on every policy', () => {
    expect(
      migration.match(/company_id = public\.current_active_company_id\(\)/g),
    ).toHaveLength(10)
    expect(
      migration.match(/public\.caller_can_write_company\(company_id\)/g),
    ).toHaveLength(10)
  })

  it('keeps connection ownership checks and matching update tenant checks', () => {
    expect(migration.match(/user_id = auth\.uid\(\)/g)).toHaveLength(2)

    const updates = migration.match(
      /CREATE POLICY "[^"]*update[^"]*"[\s\S]+?;/g,
    )
    expect(updates).toHaveLength(3)
    for (const policy of updates ?? []) {
      const exactCompanyPredicate =
        /company_id = public\.current_active_company_id\(\)[\s\S]+?public\.caller_can_write_company\(company_id\)/g
      expect(policy.match(exactCompanyPredicate)).toHaveLength(2)
      expect(policy).toContain('USING')
      expect(policy).toContain('WITH CHECK')
    }
  })
})
