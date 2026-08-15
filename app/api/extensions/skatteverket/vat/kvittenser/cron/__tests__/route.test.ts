/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn().mockReturnValue(null),
}))

vi.mock('@/extensions/general/skatteverket/lib/api-client', () => {
  class SkatteverketAuthError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message)
      this.name = 'SkatteverketAuthError'
    }
  }
  return {
    SkatteverketAuthError,
    skvRequest: vi.fn(),
    skvRequestWithAuth: vi.fn(),
    getSkatteverketEnvironment: vi.fn(() => 'test'),
  }
})

vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  getConnection: vi.fn().mockResolvedValue(null),
  markGrantRevoked: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/extensions/general/skatteverket/lib/token-store', () => ({
  RECONSENT_ERROR_CODES: [
    'SESSION_EXPIRED',
    'REFRESH_EXHAUSTED',
    'MISSING_SCOPE',
    'TOKEN_CORRUPTED',
  ] as const,
  markNeedsReconsent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/extensions/general/skatteverket/lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue({ sent: true }),
}))

vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue({ completed: 1 }),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn().mockResolvedValue(true),
}))

import { GET } from '../route'
import { createClient } from '@supabase/supabase-js'
import { verifyCronSecret } from '@/lib/auth/cron'
import { skvRequestWithAuth, SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { markNeedsReconsent } from '@/extensions/general/skatteverket/lib/token-store'
import { markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'

const mockCreateClient = vi.mocked(createClient)
const mockVerifyCronSecret = vi.mocked(verifyCronSecret)
const mockSkvRequest = vi.mocked(skvRequestWithAuth)
const mockSendKvittensNotification = vi.mocked(sendKvittensNotification)
const mockCompleteTaxDeadline = vi.mocked(completeTaxDeadline)
const mockMarkNeedsReconsent = vi.mocked(markNeedsReconsent)
const mockMarkGrantRevoked = vi.mocked(markGrantRevoked)

function makeRequest() {
  return new Request('http://localhost/api/extensions/skatteverket/vat/kvittenser/cron', {
    headers: { authorization: 'Bearer test-secret' },
  })
}

const APPROVED_RUTOR = Object.fromEntries([
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31',
  'ruta32', 'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40',
  'ruta41', 'ruta42', 'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61',
  'ruta62',
].map((key) => [key, 0]))

const LOCKED_STATE = {
  status: 'draft_locked',
  redovisare: '165560000000',
  redovisningsperiod: '202606',
  periodType: 'monthly',
  year: 2026,
  period: 6,
  resolvedPeriodStart: '2026-06-01',
  resolvedPeriodEnd: '2026-06-30',
  originalPeriodStart: '2026-06-01',
  originalPeriodEnd: '2026-06-30',
  fiscalPeriodId: null,
  fiscalPeriodStart: null,
  fiscalPeriodEnd: null,
  vatLiabilityStartDate: null,
  approvedRutor: APPROVED_RUTOR,
  approvedMomsuppgift: { summaMoms: 0 },
  updatedAt: '2026-06-30T12:00:00.000Z',
  signeringsLank: 'https://skv.test/sign/abc',
}

function makeSupabaseStub(
  tables: Record<string, { data: unknown; error?: unknown; updateError?: unknown }>,
) {
  return {
    from: vi.fn((table: string) => {
      const result = tables[table] ?? { data: null, error: null }
      const resolved = { data: result.data, error: result.error ?? null }
      const chain: any = {}
      let isUpdate = false
      for (const method of ['select', 'eq', 'in', 'like', 'order', 'limit', 'delete', 'insert']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.update = vi.fn(() => {
        isUpdate = true
        return chain
      })
      chain.maybeSingle = vi.fn().mockImplementation(async () =>
        isUpdate && result.updateError
          ? { data: null, error: result.updateError }
          : resolved,
      )
      chain.single = vi.fn().mockResolvedValue(resolved)
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(isUpdate && result.updateError ? { data: null, error: result.updateError } : resolved)
      return chain
    }),
  } as any
}

function stubHappyTables(state: Record<string, unknown> = LOCKED_STATE) {
  return makeSupabaseStub({
    extension_data: {
      data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(state) }],
    },
    skatteverket_tokens: { data: { user_id: 'user-1', status: 'active' } },
    company_settings: {
      data: { moms_period: 'monthly', vat_liability_start_date: null },
    },
    fiscal_periods: {
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        period_start: '2025-07-01',
        period_end: '2026-06-30',
      },
    },
  })
}

describe('VAT kvittenser cron', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SKATTEVERKET_ENABLED = 'true'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    mockVerifyCronSecret.mockReturnValue(null)
    mockMarkNeedsReconsent.mockResolvedValue(undefined)
    mockMarkGrantRevoked.mockResolvedValue(undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('returns 401 when cron auth fails', async () => {
    mockVerifyCronSecret.mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) as any,
    )
    const res = await GET(makeRequest())
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('no-ops when the extension flag is off', async () => {
    process.env.SKATTEVERKET_ENABLED = 'false'
    const res = await GET(makeRequest())
    const body = await res.json()
    expect(body.processed).toBe(0)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('marks the filing signed, completes the moms deadline, and notifies', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-123', tidpunkt: '2026-07-01T10:00:00Z' }),
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed, JSON.stringify(
      { body, errors: errorSpy.mock.calls },
      (_key, value) => value instanceof Error ? value.message : value,
    )).toBe(1)
    expect(body.errors).toBe(0)
    expect(body.results[0]).toMatchObject({ companyId: 'comp-1', period: '202606', status: 'signed' })

    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      expect.anything(),
      'comp-1',
      ['moms_monthly'],
      '2026-06',
      'confirmed',
      {
        year: 2026,
        month: 6,
        start: '2026-06-01',
        end: '2026-06-30',
        original_start: '2026-06-01',
        original_end: '2026-06-30',
        vat_liability_start_date: null,
      },
    )
    expect(mockSendKvittensNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: 'comp-1',
        userId: 'user-1',
        kind: 'vat',
        kvittensnummer: 'KV-123',
      }),
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('keeps receipt reconciliation retryable when the exact deadline is unavailable', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-123' }),
    } as any)
    mockCompleteTaxDeadline.mockResolvedValueOnce({ completed: 0 })

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(0)
    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      period: '202606',
      status: 'error',
    })
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('quarterly picker params produce a YYYY-QN tax period', async () => {
    mockCreateClient.mockReturnValueOnce(
      stubHappyTables({
        ...LOCKED_STATE,
        periodType: 'quarterly',
        period: 2,
        resolvedPeriodStart: '2026-04-01',
        originalPeriodStart: '2026-04-01',
      }),
    )
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-456' }),
    } as any)

    await GET(makeRequest())

    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      expect.anything(), 'comp-1', ['moms_quarterly'], '2026-Q2', 'confirmed',
      {
        year: 2026,
        quarter: 2,
        start: '2026-04-01',
        end: '2026-06-30',
        original_start: '2026-04-01',
        original_end: '2026-06-30',
        vat_liability_start_date: null,
      },
    )
  })

  it('completes the exact linked annual fiscal-period deadline', async () => {
    const linkedReportPeriod = {
      fiscal_period_id: '11111111-1111-4111-8111-111111111111',
      fiscal_period_start: '2025-07-01',
      fiscal_period_end: '2026-06-30',
      start: '2025-07-01',
      end: '2026-06-30',
      original_start: '2025-07-01',
      original_end: '2026-06-30',
      vat_liability_start_date: null,
    }
    mockCreateClient.mockReturnValueOnce(stubHappyTables({
      ...LOCKED_STATE,
      periodType: 'yearly',
      period: 1,
      resolvedPeriodStart: '2025-07-01',
      originalPeriodStart: '2025-07-01',
      fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
      fiscalPeriodStart: '2025-07-01',
      fiscalPeriodEnd: '2026-06-30',
    }))
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-999' }),
    } as any)

    await GET(makeRequest())

    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      expect.anything(),
      'comp-1',
      ['moms_yearly'],
      '2025/2026',
      'confirmed',
      linkedReportPeriod,
    )
  })

  it('fails closed on legacy state without the immutable identity', async () => {
    const { approvedRutor: _rutor, ...legacyState } = LOCKED_STATE
    mockCreateClient.mockReturnValueOnce(stubHappyTables(legacyState))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(body.message).toBe('No locked drafts')
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      '[vat-kvittenser-cron] Invalid submission state',
      expect.objectContaining({ companyId: 'comp-1' }),
    )
  })

  it('records still_pending on 404 without touching state', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 404 } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.stillPending).toBe(1)
    expect(body.signed).toBe(0)
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('skips rows that are not draft_locked', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables({ ...LOCKED_STATE, status: 'draft_saved' }))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(0)
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('flags reconsent codes as expired_token and marks the connection', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockRejectedValueOnce(
      new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'),
    )

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.expired).toBe(1)
    expect(body.results[0]).toMatchObject({ status: 'expired_token', error: 'SESSION_EXPIRED' })
    expect(mockMarkNeedsReconsent).toHaveBeenCalledWith(expect.anything(), 'user-1', 'comp-1', 'SESSION_EXPIRED')
  })

  it('records error for generic failures without aborting the run', async () => {
    mockCreateClient.mockReturnValueOnce(stubHappyTables())
    mockSkvRequest.mockRejectedValueOnce(new Error('fetch failed'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      status: 'error',
      error: 'Något gick fel. Försök igen.',
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps exact deadline completion idempotent when signed-state persistence fails', async () => {
    mockCreateClient.mockReturnValueOnce(
      makeSupabaseStub({
        extension_data: {
          data: [{ company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) }],
          updateError: { message: 'connection reset', code: '08006' },
        },
        skatteverket_tokens: { data: { user_id: 'user-1', status: 'active' } },
        company_settings: {
          data: { moms_period: 'monthly', vat_liability_start_date: null },
        },
      }),
    )
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-123' }),
    } as any)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.signed).toBe(0)
    expect(body.errors).toBe(1)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      period: '202606',
      status: 'error',
      error: 'Failed to persist signed state: connection reset',
    })
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  function stubTwoCompanyTables() {
    return makeSupabaseStub({
      extension_data: {
        data: [
          { company_id: 'comp-1', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) },
          { company_id: 'comp-2', key: 'submission_202606', value: JSON.stringify(LOCKED_STATE) },
        ],
      },
      skatteverket_tokens: { data: { user_id: 'user-1', status: 'active' } },
      company_settings: {
        data: { moms_period: 'monthly', vat_liability_start_date: null },
      },
    })
  }

  it('a throwing markGrantRevoked does not abort the remaining companies', async () => {
    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest
      .mockRejectedValueOnce(new SkatteverketAuthError('Ombud saknas.', 'OMBUD_GRANT_MISSING'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ kvittensnummer: 'KV-123' }),
      } as any)
    mockMarkGrantRevoked.mockRejectedValueOnce(new Error('db outage'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(2)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      status: 'error',
      error: 'OMBUD_GRANT_MISSING',
    })
    expect(body.results[1]).toMatchObject({ companyId: 'comp-2', status: 'signed' })
    expect(mockMarkGrantRevoked).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('a throwing markNeedsReconsent does not abort the remaining companies', async () => {
    mockCreateClient.mockReturnValueOnce(stubTwoCompanyTables())
    mockSkvRequest
      .mockRejectedValueOnce(new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ kvittensnummer: 'KV-456' }),
      } as any)
    mockMarkNeedsReconsent.mockRejectedValueOnce(new Error('network blip'))

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(body.processed).toBe(2)
    expect(body.results[0]).toMatchObject({
      companyId: 'comp-1',
      status: 'expired_token',
      error: 'SESSION_EXPIRED',
    })
    expect(body.results[1]).toMatchObject({ companyId: 'comp-2', status: 'signed' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
