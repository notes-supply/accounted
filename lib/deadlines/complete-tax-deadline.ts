import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('complete-tax-deadline')

/**
 * Mark a system-generated tax deadline as completed from an external signal
 * (a declaration was generated, filed, or decided).
 *
 * Deadline completion is a courtesy on top of the filing flow, never part of
 * it: this helper logs failures and returns instead of throwing, so a broken
 * deadline row can never block a submission to Skatteverket.
 *
 * `taxPeriod` must use the deadline generator's format
 * (lib/tax/deadline-generator.ts): `YYYY-MM` for monthly, `YYYY-QN` for
 * quarterly, `YYYY` for annual. Build it from the caller's own period params;
 * do not reverse-parse Skatteverket's redovisningsperiod strings.
 *
 * The caller must pass the one exact generated deadline type represented by
 * the authoritative filing identity. Ambiguous or unavailable evidence is a
 * no-op: this helper never broad-updates candidate rows.
 */
export async function completeTaxDeadline(
  supabase: SupabaseClient,
  companyId: string,
  taxDeadlineType: string,
  taxPeriod: string,
  newStatus: 'submitted' | 'confirmed',
  options: {
    fiscalPeriodId?: string
    fiscalPeriodStart?: string
    fiscalPeriodEnd?: string
  } = {},
): Promise<{ completed: number }> {
  let candidatesQuery = supabase
    .from('deadlines')
    .select('id')
    .eq('company_id', companyId)
    .eq('deadline_type', 'tax')
    .eq('source', 'system')
    .eq('tax_deadline_type', taxDeadlineType)
    .eq('tax_period', taxPeriod)
    .eq('is_completed', false)
    .is('dismissed_at', null)

  if (options.fiscalPeriodId) {
    candidatesQuery = candidatesQuery.contains('linked_report_period', {
      fiscalPeriodId: options.fiscalPeriodId,
      ...(options.fiscalPeriodStart ? { fiscalPeriodStart: options.fiscalPeriodStart } : {}),
      ...(options.fiscalPeriodEnd ? { fiscalPeriodEnd: options.fiscalPeriodEnd } : {}),
    })
  }

  const { data: candidates, error: candidateError } = await candidatesQuery.limit(2)

  if (candidateError || candidates?.length !== 1) {
    log.warn('Tax deadline completion candidate was unavailable or ambiguous', {
      companyId,
      taxDeadlineType,
      taxPeriod,
      candidateCount: candidates?.length ?? 0,
      error: candidateError?.message,
    })
    return { completed: 0 }
  }

  const now = new Date().toISOString()
  let query = supabase
    .from('deadlines')
    .update({
      is_completed: true,
      completed_at: now,
      status: newStatus,
      status_changed_at: now,
    })
    .eq('id', candidates[0].id)
    .eq('company_id', companyId)
    .eq('deadline_type', 'tax')
    .eq('source', 'system')
    .eq('tax_deadline_type', taxDeadlineType)
    .eq('tax_period', taxPeriod)
    .eq('is_completed', false)
    .is('dismissed_at', null)

  if (options.fiscalPeriodId) {
    query = query.contains('linked_report_period', {
      fiscalPeriodId: options.fiscalPeriodId,
      ...(options.fiscalPeriodStart ? { fiscalPeriodStart: options.fiscalPeriodStart } : {}),
      ...(options.fiscalPeriodEnd ? { fiscalPeriodEnd: options.fiscalPeriodEnd } : {}),
    })
  }

  const { data, error } = await query.select('id')

  if (error) {
    log.warn('Failed to auto-complete tax deadline', {
      companyId,
      taxDeadlineType,
      taxPeriod,
      error: error.message,
    })
    return { completed: 0 }
  }

  return { completed: data?.length === 1 ? 1 : 0 }
}
