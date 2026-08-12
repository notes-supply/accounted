import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')
}

describe('mail hunt additive hardening migrations', () => {
  it('keeps the imported attachment dedupe migration byte-identical', () => {
    const sql = migration('20260807103000_mail_hunt_dedupe_per_attachment.sql')
    expect(createHash('sha256').update(sql).digest('hex'))
      .toBe('80963aeddbcb97a50db95d35c8d5bd47964e95ff5dfd14c435e3baff31b30e0f')
  })

  it('normalizes only uniquely proven legacy connections and aliases unresolved rows', () => {
    const sql = migration('20260810132000_mail_hunt_legacy_connection_dedupe.sql')

    expect(sql).toContain('mail_connection_id')
    expect(sql).toContain('mail_legacy_file_key')
    expect(sql).toMatch(/company_id[\s\S]*provider[\s\S]*email_address/)
    expect(sql).toMatch(/count\(\*\)[\s\S]*= 1/)
    expect(sql).toContain("channel_context->>'mail_file_key'")
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*mail_message_id[\s\S]*mail_attachment_id/i)
  })

  it('defines a service-only atomic staging RPC with both deadline checks', () => {
    const sql = migration('20260810133000_stage_receipt_hunt_before_deadline.sql')

    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain("SET search_path = ''")
    expect(sql.match(/clock_timestamp\(\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(sql).toMatch(/operation_type' IS DISTINCT FROM 'attach_document_to_transaction'/)
    expect(sql).toMatch(/actor_type' IS DISTINCT FROM 'cron'/)
    expect(sql).toMatch(/actor_label' IS DISTINCT FROM 'Kvittojakten'/)
    expect(sql).toMatch(/risk_level' IS DISTINCT FROM 'medium'/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/)
  })
})
