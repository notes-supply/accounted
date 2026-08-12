import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')
}

describe('F-skatt 2013 additive migration chain', () => {
  it('keeps the imported broad migration byte-identical', () => {
    const sql = migration('20260810120000_f_skatt_ef_template_2013.sql')
    expect(createHash('sha256').update(sql).digest('hex'))
      .toBe('d9460e1d679b080220318629955f35cef08d9877a11c45b46db0d7ee797c3aaa')
  })

  it('snapshots only provenance-proven custom EF templates before the imported update', () => {
    const sql = migration('20260810115959_preserve_custom_2012_templates.sql')
    const lockAt = sql.indexOf(
      'LOCK TABLE public.booking_template_library IN SHARE ROW EXCLUSIVE MODE',
    )
    const snapshotAt = sql.indexOf('INSERT INTO public._btl_custom_2012_preservation')
    const fenceAt = sql.indexOf('CREATE TRIGGER btl_custom_2012_write_fence')

    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(lockAt).toBeLessThan(snapshotAt)
    expect(snapshotAt).toBeLessThan(fenceAt)
    expect(sql).toContain('is_system = false')
    expect(sql).toContain("entity_type = 'enskild_firma'")
    expect(sql).toContain(`lines @> '[{"account": "2012"}]'`)
    expect(sql).toContain('original_lines')
    expect(sql).toContain('original_updated_at')
    expect(sql).toContain('expected_imported_lines')
    expect(sql).toContain('original_other_fields')
    expect(sql).toContain('btl_custom_2012_write_fence')
    expect(sql).toContain('session_user')
    expect(sql).toContain('current_user')
    expect(sql).not.toContain('SECURITY DEFINER')
  })

  it('restores exact custom values and removes all helper state', () => {
    const sql = migration('20260810130500_restore_custom_2012_templates.sql')
    expect(sql).toContain('s.original_lines')
    expect(sql).toContain('s.original_updated_at')
    expect(sql).toContain('s.expected_imported_lines')
    expect(sql).toMatch(/b\.lines IS DISTINCT FROM s\.expected_imported_lines/)
    expect(sql).toContain('s.original_other_fields')
    expect(sql).toContain('is_system = false')
    expect(sql).toMatch(/DROP TRIGGER btl_custom_2012_write_fence/)
    expect(sql).toMatch(/DROP FUNCTION public\.fence_custom_2012_templates/)
    expect(sql).toMatch(/DROP TABLE public\._btl_custom_2012_preservation/)
  })

  it('guards the exact seeded F-tax template and Skattekonto rule identities', () => {
    const sql = migration('20260810131000_guarded_f_skatt_ef_2013.sql')
    expect(sql).toContain("pack_slug = 'preliminar-f-skatt-ef'")
    expect(sql).toContain("name = 'Preliminär F-skatt (EF)'")
    expect(sql).toContain("pattern = 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt'")
    expect(sql).toContain("counter_account = '2510'")
    expect(sql).toContain("counter_account_ef IN ('2012', '2013')")
    expect(sql.match(/RAISE EXCEPTION/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
