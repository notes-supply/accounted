import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

describe('VAT liability-start schema contract', () => {
  it('adds one nullable date column without backfilling existing settings', async () => {
    const tenant = await seedCompany()
    const settingsId = randomUUID()
    await getPool().query(
      `INSERT INTO public.company_settings (id, company_id, user_id, company_name)
       VALUES ($1, $2, $3, 'M1 existing row')`,
      [settingsId, tenant.companyId, tenant.userId],
    )

    const metadata = await getPool().query<{
      data_type: string
      is_nullable: 'YES' | 'NO'
      column_default: string | null
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'company_settings'
          AND column_name = 'vat_liability_start_date'`,
    )
    expect(metadata.rows).toEqual([
      { data_type: 'date', is_nullable: 'YES', column_default: null },
    ])

    const existing = await getPool().query<{ vat_liability_start_date: string | null }>(
      `SELECT vat_liability_start_date::text
         FROM public.company_settings
        WHERE id = $1`,
      [settingsId],
    )
    expect(existing.rows[0]?.vat_liability_start_date).toBeNull()
  })

  it('inherits the existing tenant policies for update and read isolation', async () => {
    const owner = await seedCompany()
    const outsider = await seedCompany()
    const settingsId = randomUUID()
    await getPool().query(
      `INSERT INTO public.company_settings (id, company_id, user_id, company_name)
       VALUES ($1, $2, $3, 'M1 tenant row')`,
      [settingsId, owner.companyId, owner.userId],
    )

    await withUserContext(owner.userId, async (client) => {
      const updated = await client.query<{ vat_liability_start_date: string }>(
        `UPDATE public.company_settings
            SET vat_liability_start_date = DATE '2026-04-17'
          WHERE id = $1
          RETURNING vat_liability_start_date::text`,
        [settingsId],
      )
      expect(updated.rows[0]?.vat_liability_start_date).toBe('2026-04-17')
    })

    await withUserContext(outsider.userId, async (client) => {
      const selected = await client.query(
        `SELECT id FROM public.company_settings WHERE id = $1`,
        [settingsId],
      )
      expect(selected.rowCount).toBe(0)

      const updated = await client.query(
        `UPDATE public.company_settings
            SET vat_liability_start_date = DATE '2026-05-01'
          WHERE id = $1`,
        [settingsId],
      )
      expect(updated.rowCount).toBe(0)
    })
  })
})
