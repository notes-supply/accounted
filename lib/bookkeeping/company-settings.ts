import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { BookkeepingDatabaseError } from './errors'

export interface CategorizationCompanySettings {
  entityType: EntityType
  fiscalYearStartMonth: number
}

/**
 * Load the entity-sensitive settings required before transaction posting.
 *
 * A genuinely absent legacy row retains the established sole-trader/calendar-
 * year defaults. Query and RLS failures are different: they must stop before a
 * voucher can be created with accounts for the wrong legal entity.
 */
export async function loadCategorizationCompanySettings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CategorizationCompanySettings> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    throw new BookkeepingDatabaseError('fetch_company_settings', error.message)
  }

  return {
    entityType: (data?.entity_type as EntityType | null) ?? 'enskild_firma',
    fiscalYearStartMonth: data?.fiscal_year_start_month ?? 1,
  }
}
