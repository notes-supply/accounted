import { NextResponse } from 'next/server'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.uncategorize',
  async (_request, { supabase, user, companyId }, { params }) => {
    const { id } = await params

    // Fetch transaction
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .select('id, journal_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (txError || !transaction) {
      return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
    }

    if (!transaction.journal_entry_id) {
      return NextResponse.json({ error: 'Transaction has no journal entry' }, { status: 400 })
    }

    // Verify journal entry is posted
    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', transaction.journal_entry_id)
      .eq('company_id', companyId)
      .single()

    if (entryError || !entry) {
      return NextResponse.json({ error: 'Journal entry not found' }, { status: 400 })
    }

    if (entry.status !== 'posted') {
      return NextResponse.json({ error: 'Journal entry is not posted' }, { status: 400 })
    }

    // The M5 command performs the storno, exact pointer clear, durable
    // publications, and idempotent recovery in one database transaction.
    const { data: compensation, error: compensationError } = await supabase.rpc(
      'compensate_transaction_categorization',
      {
        p_company_id: companyId,
        p_transaction_id: id,
        p_original_journal_entry_id: transaction.journal_entry_id,
        p_actor_type: 'user',
        p_actor_id: user.id,
        p_actor_label: null,
      },
    )

    if (compensationError) {
      const typed = bookkeepingErrorResponse(compensationError)
      if (typed) return typed
      return NextResponse.json(
        { error: getErrorMessage(compensationError, { context: 'transaction' }) },
        { status: 500 },
      )
    }

    if (
      !compensation
      || typeof compensation !== 'object'
      || !('status' in compensation)
      || (compensation.status !== 'applied' && compensation.status !== 'already_applied')
    ) {
      return NextResponse.json(
        { error: 'Transaction changed during uncategorization' },
        { status: 409 },
      )
    }

    return NextResponse.json({ success: true })

  },
  { requireWrite: true },
)
