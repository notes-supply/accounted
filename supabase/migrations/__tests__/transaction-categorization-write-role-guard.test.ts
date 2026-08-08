import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260808162000_transaction_categorization_write_role_guard.sql',
  ),
  'utf8',
)

describe('transaction categorization RPC write-role guard migration', () => {
  it('defines a NULL-safe company-scoped helper from auth.uid and canonical roles', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.caller_can_write_company\(p_company_id uuid\)/,
    )
    expect(migration).toMatch(/cm\.user_id = auth\.uid\(\)/)
    expect(migration).toMatch(/cm\.company_id = p_company_id/)
    expect(migration).toMatch(/cm\.role IN \('owner', 'admin', 'member'\)/)
    expect(migration).toMatch(/p_company_id IS NOT NULL/)
    expect(migration).not.toMatch(/p_(?:user|actor|caller)_id/)
  })

  it('convergently rewrites both categorization RPCs to the writable-role helper', () => {
    expect(migration).toContain('attach_transaction_categorization')
    expect(migration).toContain('compensate_transaction_categorization')
    expect(migration).toContain('public.caller_can_write_company(p_company_id)')
    expect(migration).toContain('public.caller_is_company_member(p_company_id)')
    expect(migration).not.toContain(
      'p_company_id NOT IN (SELECT public.user_company_ids())',
    )
  })
})
