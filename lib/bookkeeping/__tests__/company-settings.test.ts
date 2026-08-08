import { describe, expect, it } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'
import { loadCategorizationCompanySettings } from '../company-settings'

describe('loadCategorizationCompanySettings', () => {
  it('returns aktiebolag settings when the company row exists', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({
      data: { entity_type: 'aktiebolag', fiscal_year_start_month: 7 },
      error: null,
    })

    await expect(
      loadCategorizationCompanySettings(supabase as never, 'company-ab'),
    ).resolves.toEqual({ entityType: 'aktiebolag', fiscalYearStartMonth: 7 })
  })

  it('uses the established legacy defaults only when the row is genuinely absent', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: null })

    await expect(
      loadCategorizationCompanySettings(supabase as never, 'legacy-company'),
    ).resolves.toEqual({ entityType: 'enskild_firma', fiscalYearStartMonth: 1 })
  })

  it('throws a typed database error instead of defaulting when the query fails', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null, error: { message: 'permission denied', code: '42501' } })

    await expect(
      loadCategorizationCompanySettings(supabase as never, 'company-ab'),
    ).rejects.toMatchObject({
      name: 'BookkeepingDatabaseError',
      operation: 'fetch_company_settings',
      cause: 'permission denied',
    })
  })
})
