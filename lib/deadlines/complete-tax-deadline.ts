import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('complete-tax-deadline')

/**
 * Mark one exact system-generated tax deadline from an external filing
 * signal. Ambiguous, missing, or concurrently changed matches are a no-op.
 * Repeating the same signal is idempotent, and a later confirmed signal may
 * promote an already submitted deadline without reopening it.
 *
 * `taxPeriod` uses the deadline generator's format: `YYYY-MM` for monthly,
 * `YYYY-QN` for quarterly, and `YYYY-MM-DD/YYYY-MM-DD` for annual VAT.
 * VAT callers also pass the immutable linked report period so another deadline
 * with the same display period cannot be completed by mistake.
 */
export async function completeTaxDeadline(
  supabase: SupabaseClient,
  companyId: string,
  taxDeadlineTypes: string[],
  taxPeriod: string,
  newStatus: 'submitted' | 'confirmed',
  linkedReportPeriod?: Record<string, unknown>,
): Promise<{ completed: number }> {
  let matchQuery = supabase
    .from('deadlines')
    .select('id, is_completed, status')
    .eq('company_id', companyId)
    .in('tax_deadline_type', taxDeadlineTypes)
    .eq('tax_period', taxPeriod)
    .eq('source', 'system')
    .eq('is_auto_generated', true)
  if (linkedReportPeriod) {
    matchQuery = matchQuery
      .contains('linked_report_period', linkedReportPeriod)
      .containedBy('linked_report_period', linkedReportPeriod)
  }
  const { data: matches, error: matchError } = await matchQuery.limit(2)

  if (matchError || matches?.length !== 1) {
    if (matchError || (matches?.length ?? 0) > 1) {
      log.warn('Failed to identify one tax deadline for auto-completion', {
        companyId,
        taxDeadlineTypes,
        taxPeriod,
        error: matchError?.message ?? 'ambiguous deadline identity',
      })
    }
    return { completed: 0 }
  }

  const match = matches[0] as {
    id: string
    is_completed: boolean
    status: string | null
  }
  if (
    match.is_completed
    && (match.status === newStatus || match.status === 'confirmed')
  ) {
    return { completed: 1 }
  }

  const now = new Date().toISOString()
  let updateQuery = supabase
    .from('deadlines')
    .update({
      is_completed: true,
      completed_at: now,
      status: newStatus,
      status_changed_at: now,
    })
    .eq('id', match.id)
    .eq('company_id', companyId)
    .eq('is_completed', match.is_completed)
    .eq('source', 'system')
    .eq('is_auto_generated', true)
  updateQuery = match.status === null
    ? updateQuery.is('status', null)
    : updateQuery.eq('status', match.status)
  const { data, error } = await updateQuery.select('id')

  if (error) {
    log.warn('Failed to auto-complete tax deadline', {
      companyId,
      taxDeadlineTypes,
      taxPeriod,
      error: error.message,
    })
    return { completed: 0 }
  }

  return { completed: data?.length === 1 ? 1 : 0 }
}
