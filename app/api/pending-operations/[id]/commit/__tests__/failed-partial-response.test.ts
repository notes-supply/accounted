import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const commitMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitMock(...args),
}))

import { POST } from '../../commit/route'

describe('POST pending-operation commit failed-partial response', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@test.se' } },
    })
  })

  it('preserves posted journal ids in the stable partial_posted_ids field', async () => {
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        user_id: 'user-1',
        operation_type: 'categorize_transaction',
        status: 'pending',
        params: {},
        preview_data: {},
      },
      error: null,
    })
    commitMock.mockResolvedValue({
      status: 'failed',
      error: 'compensation unverifiable',
      http_status: 500,
      code: 'partial_commit',
      data: {
        posted_ids: {
          journal_entry_id: 'je-original',
          reversal_journal_entry_id: 'je-storno',
        },
        partial_failure_state: {
          persistence: 'database_error',
          operation_status: 'committing',
        },
        internal_debug: 'must not leak',
      },
    })

    const response = await POST(
      createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' }),
      createMockRouteParams({ id: 'op-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      error: string
      partial_posted_ids?: Record<string, string>
      partial_failure_state?: Record<string, string>
      internal_debug?: string
    }>(response)

    expect(status).toBe(500)
    expect(body.partial_posted_ids).toEqual({
      journal_entry_id: 'je-original',
      reversal_journal_entry_id: 'je-storno',
    })
    expect(body.partial_failure_state).toEqual({
      persistence: 'database_error',
      operation_status: 'committing',
    })
    expect(body).not.toHaveProperty('internal_debug')
  })

  it('omits partial_posted_ids for an ordinary failure', async () => {
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        user_id: 'user-1',
        operation_type: 'categorize_transaction',
        status: 'pending',
        params: {},
        preview_data: {},
      },
      error: null,
    })
    commitMock.mockResolvedValue({
      status: 'failed',
      error: 'ordinary failure',
      http_status: 500,
    })

    const response = await POST(
      createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' }),
      createMockRouteParams({ id: 'op-1' }),
    )
    const body = await response.json()

    expect(body).not.toHaveProperty('partial_posted_ids')
  })
})
