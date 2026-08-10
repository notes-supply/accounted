import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encryptToken } from '../crypto'

const ORIGINAL = {
  nodeEnv: process.env.NODE_ENV,
  dedicated: process.env.MAIL_TOKEN_ENCRYPTION_KEY,
  shared: process.env.SUPABASE_SERVICE_ROLE_KEY,
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'development-service-role-key'
  delete process.env.MAIL_TOKEN_ENCRYPTION_KEY
})

afterEach(() => {
  restore('NODE_ENV', ORIGINAL.nodeEnv)
  restore('MAIL_TOKEN_ENCRYPTION_KEY', ORIGINAL.dedicated)
  restore('SUPABASE_SERVICE_ROLE_KEY', ORIGINAL.shared)
})

describe('MAIL_TOKEN_ENCRYPTION_KEY configuration', () => {
  it('requires a dedicated key in production and never falls back to the service-role key', () => {
    restore('NODE_ENV', 'production')
    expect(() => encryptToken('refresh-token')).toThrow(/MAIL_TOKEN_ENCRYPTION_KEY.*required/i)
  })

  it.each(['short', 'z'.repeat(64), `${'a'.repeat(63)} `])(
    'rejects a malformed dedicated key: %s',
    (key) => {
      process.env.MAIL_TOKEN_ENCRYPTION_KEY = key
      expect(() => encryptToken('refresh-token')).toThrow(/32 bytes of hex/i)
    },
  )

  it('accepts exactly 32 bytes of hex in production', () => {
    restore('NODE_ENV', 'production')
    process.env.MAIL_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32)
    expect(encryptToken('refresh-token')).toEqual(expect.any(String))
  })

  it('keeps the shared-key fallback development-only', () => {
    restore('NODE_ENV', 'development')
    expect(encryptToken('refresh-token')).toEqual(expect.any(String))
  })
})
