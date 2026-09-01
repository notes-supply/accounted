import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))


import { POST } from '../route'

describe('POST /api/transactions/[id]/uncategorize', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(body).toEqual({ error: 'Forbidden' })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Transaction not found' })
  })

  it('returns 400 when transaction has no journal entry', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: null }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Transaction has no journal entry' })
  })

  it('returns 400 when journal entry is not posted', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'draft' }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(body).toEqual({ error: 'Journal entry is not posted' })
  })

  it('returns 500 when atomic compensation fails', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted' }, error: null })
    enqueue({ data: null, error: { message: 'Period is locked' } })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'Kunde inte hantera transaktionen. Försök igen.' })
  })

  it('returns 200 after the atomic compensation command succeeds', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted' }, error: null })
    enqueue({ data: { status: 'applied' }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'compensate_transaction_categorization',
      {
        p_company_id: 'company-1',
        p_transaction_id: 'tx-1',
        p_original_journal_entry_id: 'je-1',
        p_actor_type: 'user',
        p_actor_id: 'user-1',
        p_actor_label: null,
      },
    )
  })

  it('returns 409 when the compensation readback reports a lost pointer race', async () => {
    enqueue({ data: { id: 'tx-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'je-1', status: 'posted' }, error: null })
    enqueue({ data: { status: 'conflict' }, error: null })

    const request = createMockRequest('/api/transactions/tx-1/uncategorize', { method: 'POST' })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(409)
    expect(body).toEqual({ error: 'Transaction changed during uncategorization' })
  })
})
