import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { generateReconciliation } from '@/lib/reports/supplier-reconciliation'

export const GET = withRouteContext('report.supplier_ledger', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const asOfDate = searchParams.get('as_of_date') || undefined
  const periodId = searchParams.get('period_id') || undefined

  let cutoffDate = asOfDate
  if (periodId) {
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('period_end')
      .eq('company_id', companyId)
      .eq('id', periodId)
      .maybeSingle()
    if (error) throw error
    if (!period) throw new Error('Fiscal period not found')
    cutoffDate ??= period.period_end
  }

  const ledger = await generateSupplierLedger(supabase, companyId, cutoffDate)

  let reconciliation = null
  if (periodId) {
    reconciliation = await generateReconciliation(supabase, companyId, periodId, cutoffDate)
  }

  return NextResponse.json({
    data: {
      ledger,
      reconciliation,
    },
  })
})
