import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { updateDraftEntry } from '@/lib/bookkeeping/engine'
import {
  BookkeepingDatabaseError,
  CannotDeleteNonDraftError,
  JournalEntryNotFoundError,
  bookkeepingErrorResponse,
} from '@/lib/bookkeeping/errors'

const logger = createLogger('journal-entries')

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.get',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      // PostgREST's "no rows" message is raw English; the user just needs to
      // know the verifikat is gone (matches JOURNAL_ENTRY_NOT_FOUND registry).
      return NextResponse.json(
        { error: 'Verifikationen kunde inte hittas.' },
        { status: 404 }
      )
    }

    return NextResponse.json({ data })
  },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.delete',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const { data: entry, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (entryError || !entry) {
      throw new JournalEntryNotFoundError()
    }

    if (entry.status === 'draft') {
      const { data, error } = await supabase.rpc('delete_last_voucher', {
        p_company_id: companyId,
        p_entry_id: id,
      })

      if (error || !data) {
        throw new BookkeepingDatabaseError(
          'delete_draft_entry',
          error?.message ?? 'The delete RPC returned no result',
        )
      }

      await eventBus.emit({
        type: 'journal_entry.deleted',
        payload: {
          entryId: id,
          voucherSeries: data.voucher_series,
          voucherNumber: data.voucher_number,
          userId: user.id,
          companyId,
        },
      })

      return NextResponse.json({
        data: {
          action: 'deleted',
          ...data,
        },
      })
    }

    throw new CannotDeleteNonDraftError(entry.status, id)
  },
  { requireWrite: true },
)

/**
 * PATCH: edit a DRAFT verifikat in place (header + lines). Only drafts are
 * editable; updateDraftEntry rejects committed entries with a 409, and the DB
 * immutability trigger is the backstop.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.update',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, CreateJournalEntrySchema)
    if (!validation.success) return validation.response

    try {
      const entry = await updateDraftEntry(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: entry })
    } catch (err) {
      const typed = bookkeepingErrorResponse(err)
      if (typed) return typed
      // Untyped errors map to Swedish via getErrorMessage: the raw message is
      // logged here and must never reach the user verbatim (issue #337).
      logger.error('failed to update draft journal entry', { entryId: id, error: err })
      return NextResponse.json(
        { error: getErrorMessage(err, { context: 'journal_entry' }) },
        { status: 400 },
      )
    }
  },
  { requireWrite: true },
)
