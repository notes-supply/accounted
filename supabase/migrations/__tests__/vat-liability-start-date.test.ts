import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL('../20260807073000_vat_liability_start_date.sql', import.meta.url),
)

describe('VAT liability start date migration', () => {
  it('adds the column idempotently without changing its date semantics', () => {
    const sql = readFileSync(migrationPath, 'utf8')

    expect(sql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+vat_liability_start_date\s+date\b/i,
    )
  })
})
