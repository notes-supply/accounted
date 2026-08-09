/**
 * Tests for the extension's registry-exposed commit services: specifically the
 * VAT "send for signing" chain (POST /utkast → PUT /las → signeringslänk), the
 * SKATTEVERKET_ENABLED flag gate, and SkatteverketAuthError → recoverable
 * mapping. The op-lifecycle translation is covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/reports/rc-basis-gaps', () => ({ findRcBasisGaps: vi.fn(async () => []) }))

const mockSkvRequest = vi.fn()
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a) }
})

const mockWriteSkatteverketAudit = vi.fn()
vi.mock('../lib/audit', () => ({
  writeSkatteverketAudit: (...args: unknown[]) => mockWriteSkatteverketAudit(...args),
}))

const mockSettingsSet = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {},
    companyId: 'company-1',
    userId: 'user-1',
    settings: { set: (...args: unknown[]) => mockSettingsSet(...args) },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}))

import { skatteverketExtension } from '../index'
import { SkatteverketAuthError } from '../lib/api-client'

type SkvSubmitFn = (
  supabase: unknown, userId: string, companyId: string, params: Record<string, unknown>,
) => Promise<{ ok: boolean; code?: string; recoverable?: boolean; signing_url?: string }>

const commitSubmitVatDeclaration = skatteverketExtension.services!.commitSubmitVatDeclaration as unknown as SkvSubmitFn
const VAT_PARAMS = {
  period_type: 'monthly',
  year: 2025,
  period: 3,
  resolved_period_start: '2025-03-01',
  resolved_period_end: '2025-03-31',
}

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 150 },
    declaration: {
      period: { type: 'monthly', year: 2025, period: 3, start: '2025-03-01', end: '2025-03-31' },
      rutor: {
        ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
        ruta10: 0, ruta11: 0, ruta12: 0,
        ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
        ruta30: 0, ruta31: 0, ruta32: 0,
        ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
        ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
        ruta48: 0, ruta49: 0, ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
      },
    },
    resolvedPeriodStart: '2025-03-01',
    resolvedPeriodEnd: '2025-03-31',
  })
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

describe('commitSubmitVatDeclaration', () => {
  it('flag off → recoverable EXTENSION_DISABLED, zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'EXTENSION_DISABLED', recoverable: true })
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it('happy path: POST /utkast then PUT /las → ok with signing_url', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kontrollResultat: { status: 'OK' } }) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ signeringsLank: 'https://skv.test/sign/abc' }) }) // las

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)

    expect(result).toMatchObject({ ok: true, signing_url: 'https://skv.test/sign/abc' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
    // call order: utkast (POST) before las (PUT)
    expect(mockSkvRequest.mock.calls[0][2]).toBe('POST')
    expect(mockSkvRequest.mock.calls[0][3]).toMatch(/^\/utkast\/165560000000\/202503$/)
    expect(mockSkvRequest.mock.calls[1][2]).toBe('PUT')
    expect(mockSkvRequest.mock.calls[1][3]).toMatch(/^\/las\/165560000000\/202503$/)
    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      periodType: 'monthly',
      year: 2025,
      period: 3,
      fiscalPeriodId: undefined,
      resolvedPeriodStart: '2025-03-01',
      resolvedPeriodEnd: '2025-03-31',
    })
  })

  it('stable quarterly bounds reach prep unchanged and submit successfully', async () => {
    mockBuildMomsuppgift.mockResolvedValueOnce({
      redovisare: '165560000000',
      redovisningsperiod: '202506',
      momsuppgift: { summaMoms: 150 },
      declaration: {
        period: {
          type: 'quarterly', year: 2025, period: 2,
          start: '2025-05-10', end: '2025-06-30',
        },
        rutor: {},
      },
      resolvedPeriodStart: '2025-05-10',
      resolvedPeriodEnd: '2025-06-30',
    })
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ kontrollResultat: { status: 'OK' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ signeringsLank: 'https://skv.test/sign/q2' }) })

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', {
      period_type: 'quarterly',
      year: 2025,
      period: 2,
      resolved_period_start: '2025-05-10',
      resolved_period_end: '2025-06-30',
    })

    expect(result).toMatchObject({ ok: true, signing_url: 'https://skv.test/sign/q2' })
    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      periodType: 'quarterly',
      year: 2025,
      period: 2,
      fiscalPeriodId: undefined,
      resolvedPeriodStart: '2025-05-10',
      resolvedPeriodEnd: '2025-06-30',
    })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
  })

  it('utkast rejected by SKV → non-recoverable, no /las call', async () => {
    mockSkvRequest.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad rutor' })
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, recoverable: false, http_status: 400 })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1) // never reached /las
  })

  it('SkatteverketAuthError → recoverable SKATTEVERKET_NOT_CONNECTED', async () => {
    mockSkvRequest.mockRejectedValueOnce(new SkatteverketAuthError('ingen anslutning', 'NOT_CONNECTED'))
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', VAT_PARAMS)
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', recoverable: true })
  })

  it('passes immutable staged bounds to prep and makes no SKV call on drift', async () => {
    mockBuildMomsuppgift.mockRejectedValueOnce(Object.assign(
      new Error('VAT period changed since staging'),
      { code: 'VAT_PERIOD_BOUNDS_DRIFT' },
    ))
    const params = {
      period_type: 'yearly',
      year: 2026,
      period: 1,
      fiscal_period_id: 'fp-1',
      resolved_period_start: '2025-10-01',
      resolved_period_end: '2026-03-31',
    }

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', params)

    expect(result).toMatchObject({ ok: false, recoverable: false })
    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      fiscalPeriodId: 'fp-1',
      resolvedPeriodStart: '2025-10-01',
      resolvedPeriodEnd: '2026-03-31',
    })
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockWriteSkatteverketAudit).not.toHaveBeenCalled()
    expect(mockSettingsSet).not.toHaveBeenCalled()
  })

  it.each([
    {
      period_type: 'monthly', year: 2025, period: 3,
      resolved_period_start: '2025-03-14', resolved_period_end: '2025-03-31',
    },
    {
      period_type: 'quarterly', year: 2025, period: 2,
      resolved_period_start: '2025-05-10', resolved_period_end: '2025-06-30',
    },
  ])('rejects $period_type liability setting drift before SKV, audit, or settings effects', async (params) => {
    mockBuildMomsuppgift.mockRejectedValueOnce(Object.assign(
      new Error(
        `VAT period changed since staging: staged ${params.resolved_period_start}..${params.resolved_period_end}, ` +
        'declaration resolved different bounds',
      ),
      { code: 'VAT_PERIOD_BOUNDS_DRIFT' },
    ))

    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', params)

    expect(result).toMatchObject({ ok: false, recoverable: false })
    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      periodType: params.period_type,
      year: params.year,
      period: params.period,
      fiscalPeriodId: undefined,
      resolvedPeriodStart: params.resolved_period_start,
      resolvedPeriodEnd: params.resolved_period_end,
    })
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockWriteSkatteverketAudit).not.toHaveBeenCalled()
    expect(mockSettingsSet).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'absent', bounds: {} },
    { label: 'one-sided', bounds: { resolved_period_start: '2025-03-01' } },
    {
      label: 'malformed',
      bounds: { resolved_period_start: '2025-02-30', resolved_period_end: '2025-03-31' },
    },
    {
      label: 'reversed',
      bounds: { resolved_period_start: '2025-04-01', resolved_period_end: '2025-03-31' },
    },
  ])('rejects $label staged bounds before declaration prep or effects', async ({ bounds }) => {
    const result = await commitSubmitVatDeclaration({}, 'user-1', 'company-1', {
      period_type: 'monthly', year: 2025, period: 3, ...bounds,
    })

    expect(result).toMatchObject({ ok: false, recoverable: false })
    expect(mockBuildMomsuppgift).not.toHaveBeenCalled()
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockWriteSkatteverketAudit).not.toHaveBeenCalled()
    expect(mockSettingsSet).not.toHaveBeenCalled()
  })
})
