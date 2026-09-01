import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const entrypoint = path.resolve('docker-entrypoint.sh')
const requiredEnv = {
  PATH: process.env.PATH,
  NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  NEXT_PUBLIC_APP_URL: 'https://accounted.example',
  CRON_SECRET: 'cron-secret',
}

function runWithMfaEnv(env: Record<string, string | undefined>) {
  return spawnSync('sh', [entrypoint, 'true'], {
    encoding: 'utf8',
    env: { ...requiredEnv, ...env },
  })
}

describe('Docker entrypoint MFA policy validation', () => {
  it('rejects a missing private server policy before startup', () => {
    const result = runWithMfaEnv({ NEXT_PUBLIC_REQUIRE_MFA: 'false' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('REQUIRE_MFA')
  })

  it('rejects malformed boolean values before startup', () => {
    const result = runWithMfaEnv({
      REQUIRE_MFA: 'TRUE',
      NEXT_PUBLIC_REQUIRE_MFA: 'TRUE',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('REQUIRE_MFA must be exactly "true" or "false"')
  })

  it('rejects mismatched private and public policies before startup', () => {
    const result = runWithMfaEnv({
      REQUIRE_MFA: 'true',
      NEXT_PUBLIC_REQUIRE_MFA: 'false',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('REQUIRE_MFA and NEXT_PUBLIC_REQUIRE_MFA must match')
  })
})
