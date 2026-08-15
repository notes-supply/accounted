/**
 * Tests for the extension's registry-exposed commit services: specifically the
 * VAT "send for signing" chain (POST /utkast → PUT /las → signeringslänk), the
 * SKATTEVERKET_ENABLED flag gate, and SkatteverketAuthError → recoverable
 * mapping. The op-lifecycle translation is covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))
const mockSettingsSet = vi.fn().mockResolvedValue(undefined)


vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: () => ({
    supabase: {},
    companyId: 'company-1',
    userId: 'user-1',
    settings: { set: mockSettingsSet },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }),
}))

import { skatteverketExtension } from '../index'
import { SkatteverketAuthError } from '../lib/api-client'
import { rutorToMomsuppgift } from '../lib/mappers'


type SkvSubmitFn = (
  supabase: unknown, userId: string, companyId: string, params: Record<string, unknown>,
) => Promise<{ ok: boolean; code?: string; recoverable?: boolean; signing_url?: string }>

const commitSubmitVatDeclaration = skatteverketExtension.services!.commitSubmitVatDeclaration as unknown as SkvSubmitFn
const APPROVED_RUTOR = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}
const APPROVED_MOMSUPPGIFT = rutorToMomsuppgift(APPROVED_RUTOR)


const SUBMISSION_IDENTITY = {
  redovisare: '165560000000',
  redovisningsperiod: '202503',
  periodType: 'monthly' as const,
  year: 2025,
  period: 3,
  resolvedPeriodStart: '2025-03-01',
  resolvedPeriodEnd: '2025-03-31',
  originalPeriodStart: '2025-03-01',
  originalPeriodEnd: '2025-03-31',
  fiscalPeriodId: null,
  fiscalPeriodStart: null,
  fiscalPeriodEnd: null,
  vatLiabilityStartDate: null,
  approvedRutor: APPROVED_RUTOR,
  approvedMomsuppgift: APPROVED_MOMSUPPGIFT,
}

const VAT_PARAMS = {
  period_type: 'monthly',
  year: 2025,
  period: 3,
  approved_rutor: APPROVED_RUTOR,
}

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000',
    redovisningsperiod: '202503',
    momsuppgift: APPROVED_MOMSUPPGIFT,
    identity: SUBMISSION_IDENTITY,
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
    expect(mockSkvRequest.mock.calls[0][3]).toBe('POST')
    expect(mockSkvRequest.mock.calls[0][4]).toMatch(/^\/utkast\/165560000000\/202503$/)
    expect(mockSkvRequest.mock.calls[1][3]).toBe('PUT')
    expect(mockSkvRequest.mock.calls[1][4]).toMatch(/^\/las\/165560000000\/202503$/)
    expect(mockSettingsSet).toHaveBeenCalledTimes(2)
    const persistedStates = mockSettingsSet.mock.calls.map(([, value]) => JSON.parse(value as string))
    expect(persistedStates.map((state) => state.status)).toEqual(['draft_saved', 'draft_locked'])
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
})
