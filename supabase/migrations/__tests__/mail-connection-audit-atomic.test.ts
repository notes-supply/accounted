import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20260810130000_mail_connection_audit_atomic.sql',
)

describe('atomic mail connection audit migration', () => {
  const sql = readFileSync(migrationPath, 'utf8')

  it('defines narrowly scoped atomic connect, update, and disconnect RPCs', () => {
    expect(sql).toContain('upsert_mail_connection_with_audit')
    expect(sql).toContain('update_mail_connection_backfill_with_audit')
    expect(sql).toContain('disconnect_mail_connection_with_audit')
    expect(sql.match(/SECURITY DEFINER/gi)).toHaveLength(3)
    expect(sql.match(/SET search_path = ''/g)).toHaveLength(3)
  })

  it('keeps audit payloads metadata-only', () => {
    const auditStatements = sql.match(/INSERT INTO public\.audit_log[\s\S]*?;/g) ?? []
    expect(auditStatements).toHaveLength(3)
    for (const statement of auditStatements) {
      expect(statement).not.toMatch(/encrypted_(?:refresh|access)_token/i)
      expect(statement).not.toMatch(/client_secret|refresh-secret|access-secret/i)
    }
  })

  it('revokes public and client execution and grants only service_role', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(sql.match(new RegExp(`REVOKE ALL ON FUNCTION[\\s\\S]*?FROM ${role}`, 'g')))
        .toHaveLength(3)
    }
    expect(sql.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g)).toHaveLength(3)
  })

  it('requires service-role invocation and a current writable membership', () => {
    expect(sql.match(/service_role/g)?.length).toBeGreaterThanOrEqual(6)
    expect(sql.match(/company_members/g)).toHaveLength(3)
    expect(sql.match(/'owner', 'admin', 'member'/g)).toHaveLength(3)
  })
})
