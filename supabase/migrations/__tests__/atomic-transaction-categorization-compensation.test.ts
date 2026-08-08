import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260808161000_atomic_transaction_categorization_compensation.sql',
  ),
  'utf8',
)

describe('atomic transaction categorization compensation migration', () => {
  it('verifies an existing storno as a multiplicity-safe exact inverse', () => {
    expect(migration.match(/\n\s+EXCEPT ALL\n/g)).toHaveLength(2)
    expect(migration).toContain("'unverified_existing_reversal'")
    expect(migration).toMatch(/jel\.tax_code/)
    expect(migration).toMatch(/jel\.dimensions/)
  })

  it('uses the canonical NULL-safe nested tenant guard', () => {
    expect(migration).toMatch(
      /IF v_jwt_role IN \('anon', 'authenticated'\) THEN\s+IF NOT public\.caller_is_company_member\(p_company_id\) THEN\s+RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id\s+USING ERRCODE = '42501';\s+END IF;\s+END IF;/,
    )
    expect(migration).not.toContain(
      'p_company_id NOT IN (SELECT public.user_company_ids())',
    )
  })
})
