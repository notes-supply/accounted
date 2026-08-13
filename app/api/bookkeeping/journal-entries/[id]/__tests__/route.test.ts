import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  updateDraftEntry: vi.fn(),
}))

import { eventBus } from '@/lib/events/bus'

import { DELETE } from '../route'

describe('DELETE /api/bookkeeping/journal-entries/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  const run = () =>
    DELETE(
      createMockRequest('/api/bookkeeping/journal-entries/je-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'je-1' }),
    )

  it('physically deletes a draft and emits only journal_entry.deleted', async () => {
    enqueue({
      data: {
        id: 'je-1',
        status: 'draft',
        source_type: 'manual',
      },
    })
    enqueue({
      data: {
        deleted: true,
        voucher_series: 'A',
        voucher_number: 0,
        was_draft: true,
      },
    })

    const { status, body } = await parseJsonResponse<{
      data: {
        action: string
        deleted: boolean
        voucher_series: string
        voucher_number: number
        was_draft: boolean
      }
    }>(await run())

    expect(status).toBe(200)
    expect(body.data).toEqual({
      action: 'deleted',
      deleted: true,
      voucher_series: 'A',
      voucher_number: 0,
      was_draft: true,
    })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('delete_last_voucher', {
      p_company_id: 'company-1',
      p_entry_id: 'je-1',
    })
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'journal_entry.deleted',
      payload: {
        entryId: 'je-1',
        voucherSeries: 'A',
        voucherNumber: 0,
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it.each([
    ['posted', 'manual'],
    ['posted', 'invoice_paid'],
    ['posted', 'supplier_invoice_paid'],
    ['reversed', 'manual'],
    ['cancelled', 'manual'],
    ['void', 'manual'],
  ] as const)(
    'rejects status %s and source %s without any mutation',
    async (entryStatus, sourceType) => {
      enqueue({
        data: {
          id: 'je-1',
          status: entryStatus,
          source_type: sourceType,
        },
      })

      const { status, body } = await parseJsonResponse<{
        error: {
          code: string
          message: string
          message_en: string
          remediation: { description: string }
          requestId: string
          details: {
            currentStatus: string
            reversalEndpoint: string
          }
        }
      }>(await run())

      expect(status).toBe(409)
      const { requestId, ...error } = body.error
      expect(requestId).toEqual(expect.any(String))
      expect(error).toEqual({
        code: 'CANNOT_DELETE_NON_DRAFT',
        message:
          'Endast utkast kan raderas. Bokförda verifikationer återförs via den separata stornoåtgärden.',
        message_en:
          'Only draft entries can be deleted. Use the explicit reversal endpoint for a posted entry.',
        remediation: {
          description:
            'Do not retry DELETE. For a posted entry, use POST /api/bookkeeping/journal-entries/{id}/reverse; reversed and cancelled entries remain retained.',
        },
        details: {
          currentStatus: entryStatus,
          reversalEndpoint: '/api/bookkeeping/journal-entries/je-1/reverse',
        },
      })
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      expect(eventBus.emit).not.toHaveBeenCalled()
    },
  )

  it('returns the exact structured not-found error before mutation', async () => {
    enqueue({ data: null, error: { message: 'no rows' } })

    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        message: string
        message_en: string
        requestId: string
      }
    }>(await run())

    expect(status).toBe(404)
    const { requestId, ...error } = body.error
    expect(requestId).toEqual(expect.any(String))
    expect(error).toEqual({
      code: 'JOURNAL_ENTRY_NOT_FOUND',
      message: 'Verifikationen kunde inte hittas.',
      message_en: 'Journal entry not found.',
    })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('returns the exact structured database error when draft deletion fails', async () => {
    enqueue({
      data: {
        id: 'je-1',
        status: 'draft',
      },
    })
    enqueue({
      data: null,
      error: { message: 'draft deletion failed' },
    })

    const { status, body } = await parseJsonResponse<{
      error: {
        code: string
        message: string
        message_en: string
        requestId: string
        details: { operation: string }
      }
    }>(await run())

    expect(status).toBe(500)
    const { requestId, ...error } = body.error
    expect(requestId).toEqual(expect.any(String))
    expect(error).toEqual({
      code: 'BOOKKEEPING_DATABASE_ERROR',
      message: 'Verifikationen kunde inte sparas. Försök igen.',
      message_en: 'Bookkeeping database operation failed.',
      details: { operation: 'delete_draft_entry' },
    })
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
