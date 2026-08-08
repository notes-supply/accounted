/**
 * Tests for the shared VAT submit chain (kontrollera -> utkast -> lås).
 * Covers the stage discriminator semantics that the one-click route and the
 * pending-operations commit service both rely on: validation errors abort
 * before any SKV write, draft failures are retry-safe, lock failures report
 * that the draft survived in Eget utrymme.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VatDeclarationRutor } from '@/types'

const rutor: VatDeclarationRutor = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mockFindRcBasisGaps(...args),
}))

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

const PARAMS = { periodType: 'monthly' as const, year: 2026, period: 6 }

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
    momsuppgift: { summaMoms: 150 },
    declaration: {
      period: { type: 'monthly', year: 2026, period: 6, start: '2026-06-01', end: '2026-06-30' },
      rutor,
    },
    resolvedPeriodStart: '2026-06-01',
    resolvedPeriodEnd: '2026-06-30',
  })
  mockFindRcBasisGaps.mockResolvedValue([])
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
    expect(mockSkvRequest.mock.calls[0][3]).toBe('/kontrollera/165560000000/202606')
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
    expect(mockSkvRequest.mock.calls[0][3]).toBe('/utkast/165560000000/202606')
  })

  it('persists resolved annual identity in both draft and locked states', async () => {
    mockBuildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000',
      redovisningsperiod: '202603',
      momsuppgift: { summaMoms: 150 },
      declaration: {
        period: {
          type: 'yearly', year: 2026, period: 1,
          start: '2025-10-01', end: '2026-03-31', fiscalPeriodId: 'fp-annual',
        },
        rutor,
      },
      fiscalPeriodId: 'fp-annual',
      resolvedPeriodStart: '2025-10-01',
      resolvedPeriodEnd: '2026-03-31',
    })
    mockSkvRequest
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ signeringsLank: 'https://skv.test/sign/annual' }),
      })
    const ctx = makeCtx()

    await submitVatDeclarationChain(ctx, {
      periodType: 'yearly',
      year: 2026,
      period: 1,
      fiscalPeriodId: 'fp-annual',
      resolvedPeriodStart: '2025-10-01',
      resolvedPeriodEnd: '2026-03-31',
    })

    const states = (ctx.settings.set as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.parse(call[1] as string))
    expect(states).toHaveLength(2)
    for (const state of states) {
      expect(state).toMatchObject({
        fiscalPeriodId: 'fp-annual',
        resolvedPeriodStart: '2025-10-01',
        resolvedPeriodEnd: '2026-03-31',
      })
    }
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

  it('fails closed before draft, lock, or state writes when RC evidence is unavailable', async () => {
    mockFindRcBasisGaps.mockRejectedValue(new Error('evidence query failed'))
    const ctx = makeCtx()

    const result = await submitVatDeclarationChain(ctx, PARAMS, { validate: true })

    expect(result).toMatchObject({
      ok: false,
      stage: 'validation',
      httpStatus: 422,
      draftSaved: false,
      error: expect.stringContaining('RC_BASIS_SCAN_UNAVAILABLE'),
    })
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })

  it('blocks actual per-voucher RC gaps before draft, lock, or state writes', async () => {
    mockFindRcBasisGaps.mockResolvedValue([{ entryId: 'entry-gap' }])
    const ctx = makeCtx()

    const result = await submitVatDeclarationChain(ctx, PARAMS)

    expect(result).toMatchObject({
      ok: false,
      stage: 'validation',
      httpStatus: 422,
      draftSaved: false,
      error: expect.stringContaining('RC_BASIS_MISSING'),
    })
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(ctx.settings.set).not.toHaveBeenCalled()
  })
})
