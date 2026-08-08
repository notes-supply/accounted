import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260808160000_atomic_transaction_categorization_attachment.sql',
  ),
  'utf8',
)

describe('atomic transaction categorization attachment migration', () => {
  it('uses convergent additive columns and constraint replacement', () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS categorization_category text/,
    )
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS categorization_is_business boolean/,
    )
    expect(migration).toMatch(
      /DROP CONSTRAINT IF EXISTS journal_entries_categorization_metadata_coherent/,
    )
    expect(migration).toMatch(
      /ADD CONSTRAINT journal_entries_categorization_metadata_coherent/,
    )
  })

  it('uses the canonical NULL-safe nested tenant guard', () => {
    expect(migration).toMatch(
      /IF v_jwt_role IN \('anon', 'authenticated'\) THEN\s+IF NOT public\.caller_is_company_member\(p_company_id\) THEN\s+RETURN false;\s+END IF;\s+END IF;/,
    )
    expect(migration).not.toContain(
      'p_company_id NOT IN (SELECT public.user_company_ids())',
    )
  })
})
