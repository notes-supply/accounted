import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReverseEntry = vi.fn()
const mockCheckPeriodLock = vi.fn()
const mockCorrectionChainDepth = vi.fn()
let original: Record<string, unknown>
let apiContext: Record<string, unknown>

vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...args: unknown[]) => mockCheckPeriodLock(...args),
}))
vi.mock('@/lib/core/bookkeeping/correction-chain', () => ({
  CORRECTION_CHAIN_GUARD_DEPTH: 3,
  correctionChainDepth: (...args: unknown[]) => mockCorrectionChainDepth(...args),
}))
vi.mock('@/lib/bookkeeping/errors', () => ({
  CorrectionChainTooDeepError: class CorrectionChainTooDeepError extends Error {},
  isBookkeepingError: () => false,
}))
vi.mock('@/lib/api/v1/registry', () => ({
  registerEndpoint: vi.fn(),
  dataEnvelope: (schema: unknown) => schema,
}))
vi.mock('@/lib/api/v1/response', () => ({
  ok: (data: unknown) => Response.json({ data }),
}))
vi.mock('@/lib/api/v1/dry-run', () => ({
  dryRunPreview: (data: unknown) => Response.json({ data }),
}))
vi.mock('@/lib/api/v1/errors', () => ({
  v1ErrorResponse: () => Response.json({ error: { code: 'ERROR' } }, { status: 500 }),
  v1ErrorResponseFromCode: (code: string) =>
    Response.json({ error: { code } }, { status: code === 'JOURNAL_ENTRY_NOT_FOUND' ? 404 : 400 }),
}))
vi.mock('@/lib/api/v1/with-api-v1', () => ({
  withApiV1: (
    _operation: string,
    handler: (
      request: Request,
      context: Record<string, unknown>,
      route: { params: Promise<{ companyId: string; id: string }> },
    ) => Promise<Response>,
  ) => (
    request: Request,
    route: { params: Promise<{ companyId: string; id: string }> },
  ) => handler(request, apiContext, route),
}))

import { POST } from '../route'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '22222222-2222-4222-8222-222222222222'
const REVERSAL_ID = '33333333-3333-4333-8333-333333333333'
const API_KEY_ID = '44444444-4444-4444-8444-444444444444'

function makeSupabase() {
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) query[method] = vi.fn(() => query)
  query.maybeSingle = vi.fn(async () => ({ data: original, error: null }))
  return { from: vi.fn(() => query) }
}

async function reverse(body: Record<string, unknown> = {}) {
  return POST(
    new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries/${ENTRY_ID}/reverse`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID, id: ENTRY_ID }) },
  )
}

describe('v1 journal reversal adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    original = {
      id: ENTRY_ID,
      status: 'posted',
      reversed_by_id: null,
      correction_of_id: null,
      reverses_id: null,
    }
    apiContext = {
      supabase: makeSupabase(),
      companyId: COMPANY_ID,
      userId: '55555555-5555-4555-8555-555555555555',
      apiKeyId: API_KEY_ID,
      apiKeyName: 'ERP integration',
      requestId: 'request-1',
      dryRun: false,
      log: { error: vi.fn(), warn: vi.fn() },
    }
    mockCheckPeriodLock.mockResolvedValue({ locked: false })
    mockCorrectionChainDepth.mockResolvedValue({ depth: 0, rootVoucher: 'A1' })
    mockReverseEntry.mockResolvedValue({
      id: REVERSAL_ID,
      voucher_series: 'A',
      voucher_number: 2,
      entry_date: '2026-08-15',
    })
  })

  it('passes verified API-key actor identity to the core reversal contract', async () => {
    const response = await reverse({ reversal_date: '2026-08-15' })

    expect(response.status).toBe(200)
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      apiContext.userId,
      ENTRY_ID,
      '2026-08-15',
      {
        allowDeepChain: false,
        actor: {
          actor_type: 'api_key',
          actor_id: null,
          actor_label: 'ERP integration',
        },
      },
    )
  })

  it('permits exact recovery through the storno already persisted by core', async () => {
    original = { ...original, status: 'reversed', reversed_by_id: REVERSAL_ID }

    const response = await reverse({ reversal_date: '2026-08-15' })
    expect(response.status).toBe(200)
    expect(mockCheckPeriodLock).not.toHaveBeenCalled()
    expect(mockCorrectionChainDepth).not.toHaveBeenCalled()
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      apiContext.userId,
      ENTRY_ID,
      '2026-08-15',
      expect.objectContaining({
        actor: {
          actor_type: 'api_key',
          actor_id: null,
          actor_label: 'ERP integration',
        },
      }),
    )
  })
})
