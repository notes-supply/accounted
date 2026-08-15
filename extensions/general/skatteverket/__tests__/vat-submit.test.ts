/**
 * Tests for the shared VAT submit chain (kontrollera -> utkast -> lås).
 * Covers the stage discriminator semantics that the one-click route and the
 * pending-operations commit service both rely on: validation errors abort
 * before any SKV write, draft failures are retry-safe, lock failures report
 * that the draft survived in Eget utrymme.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { submitVatDeclarationChain } from '../lib/vat-submit'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { VatDeclarationRutor } from '@/types'

const RUTA_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31',
  'ruta32', 'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40',
  'ruta41', 'ruta42', 'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61',
  'ruta62',
] as const
const RUTOR = Object.fromEntries(
  RUTA_KEYS.map((key) => [key, 0]),
) as unknown as VatDeclarationRutor
const IDENTITY = {
  redovisare: '165560000000',
  redovisningsperiod: '202606',
  periodType: 'monthly' as const,
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
  approvedRutor: RUTOR,
  approvedMomsuppgift: { summaMoms: 0 },
}
const PARAMS = {
  periodType: 'monthly' as const,
  year: 2026,
  period: 6,
  approvedRutor: RUTOR,
}

function makeCtx() {
  return {
    supabase: {},
    userId: 'user-1',
    companyId: 'company-1',
    settings: { set: vi.fn().mockResolvedValue(undefined) },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExtensionContext
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildMomsuppgift.mockResolvedValue({
    redovisare: '165560000000',
    redovisningsperiod: '202606',
    momsuppgift: { summaMoms: 0 },
    rutor: RUTOR,
    identity: IDENTITY,
  })
})

describe('submitVatDeclarationChain', () => {
  it('validation ERRORs abort before any write at SKV', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        kontrollResultat: {
          status: 'ERROR',
          resultat: [{ kod: '49', status: 'ERROR', beskrivning: 'Summan stämmer inte' }],
        },
      }),
    })

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS, { validate: true })

    expect(result).toMatchObject({
      ok: false,
      stage: 'validation',
      httpStatus: 422,
      draftSaved: false,
    })
    // Only the kontrollera call: no utkast, no lås, no persisted state.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][4]).toBe('/kontrollera/165560000000/202606')
    expect((ctx.settings.set as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('validation warnings do not block: full chain runs to signing link', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          kontrollResultat: {
            status: 'WARNING',
            resultat: [{ kod: '10', status: 'WARNING', beskrivning: 'Ovanligt belopp' }],
          },
        }),
      }) // kontrollera
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ kontrollResultat: { status: 'OK' } }),
      }) // utkast
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ signeringsLank: 'https://skv.test/sign/abc' }),
      }) // lås

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS, { validate: true })

    expect(result).toMatchObject({ ok: true, signingUrl: 'https://skv.test/sign/abc' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(3)
    // Locked state persisted with the picker params for the kvittens cron.
    const setMock = ctx.settings.set as ReturnType<typeof vi.fn>
    const lastState = JSON.parse(setMock.mock.calls.at(-1)![1] as string)
    expect(lastState).toMatchObject({
      status: 'draft_locked',
      periodType: 'monthly',
      year: 2026,
      period: 6,
      signeringsLank: 'https://skv.test/sign/abc',
    })
  })

  it('skips kontrollera when validate is not requested', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ signeringsLank: 'https://skv.test/sign/xyz' }),
      }) // lås

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({ ok: true, signingUrl: 'https://skv.test/sign/xyz' })
    expect(mockSkvRequest).toHaveBeenCalledTimes(2)
    expect(mockSkvRequest.mock.calls[0][4]).toBe('/utkast/165560000000/202606')
  })

  it('utkast failure -> stage draft, nothing saved, retry-safe', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: false, status: 400, text: async () => 'bad rutor',
    })

    const ctx = makeCtx()
    const result = await submitVatDeclarationChain(ctx, PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'draft', httpStatus: 400, draftSaved: false,
    })
    expect(mockSkvRequest).toHaveBeenCalledTimes(1) // never reached /las
    expect((ctx.settings.set as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('lås failure -> stage lock with draftSaved: true', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'redan låst' }) // lås

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'lock', httpStatus: 409, draftSaved: true,
    })
  })

  it('lås without signeringsLank -> stage lock 502 with draftSaved: true', async () => {
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // utkast
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) }) // lås, no link

    const result = await submitVatDeclarationChain(makeCtx(), PARAMS)

    expect(result).toMatchObject({
      ok: false, stage: 'lock', httpStatus: 502, draftSaved: true,
    })
  })
  it('stops before utkast when the identity drifts after validation', async () => {
    mockSkvRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ kontrollResultat: { status: 'OK', resultat: [] } }),
    })
    mockBuildMomsuppgift
      .mockResolvedValueOnce({
        redovisare: IDENTITY.redovisare,
        redovisningsperiod: IDENTITY.redovisningsperiod,
        momsuppgift: { summaMoms: 0 },
        rutor: RUTOR,
        identity: IDENTITY,
      })
      .mockResolvedValueOnce({
        redovisare: IDENTITY.redovisare,
        redovisningsperiod: IDENTITY.redovisningsperiod,
        momsuppgift: { summaMoms: 0 },
        rutor: RUTOR,
        identity: { ...IDENTITY, vatLiabilityStartDate: '2026-06-02' },
      })

    await expect(
      submitVatDeclarationChain(makeCtx(), PARAMS, { validate: true }),
    ).rejects.toThrow(/identity or approved rutor changed/)
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
  })

})
