import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { VatDeclarationRutor } from '@/types'

const mocks = vi.hoisted(() => ({
  skvRequest: vi.fn(),
  skvRequestWithAuth: vi.fn(),
  buildMomsuppgift: vi.fn(),
  findRcBasisGaps: vi.fn(),
  completeTaxDeadline: vi.fn(),
  resolveReadAuth: vi.fn(),
  requireCapability: vi.fn(),
}))

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    skvRequest: (...args: unknown[]) => mocks.skvRequest(...args),
    skvRequestWithAuth: (...args: unknown[]) => mocks.skvRequestWithAuth(...args),
  }
})
vi.mock('../lib/declaration-prep', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    buildMomsuppgift: (...args: unknown[]) => mocks.buildMomsuppgift(...args),
  }
})
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mocks.findRcBasisGaps(...args),
}))
vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: (...args: unknown[]) => mocks.completeTaxDeadline(...args),
}))
vi.mock('../lib/resolve-auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    resolveReadAuth: (...args: unknown[]) => mocks.resolveReadAuth(...args),
  }
})
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    requireCapability: (...args: unknown[]) => mocks.requireCapability(...args),
  }
})
vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: vi.fn() }))

import { skatteverketExtension } from '../index'

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

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

function route(method: string, path: string) {
  const found = skatteverketExtension.apiRoutes?.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  expect(found).toBeDefined()
  return found!
}

function makeContext(
  fiscalPeriod?: { id: string; period_start: string; period_end: string },
  options: {
    orgNumber?: string
    entityType?: string
    settingsGetError?: Error
    companySettingsError?: { message: string } | null
  } = {},
) {
  const values = new Map<string, string>()
  const settings = {
    get: vi.fn(async (key: string) => {
      if (options.settingsGetError) throw options.settingsGetError
      return values.get(key) ?? null
    }),
    set: vi.fn(async (key: string, value: string) => { values.set(key, value) }),
    clear: vi.fn(async (key: string) => { values.delete(key) }),
  }
  const fiscalChain = {
    select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>
  for (const method of ['select', 'eq']) fiscalChain[method].mockReturnValue(fiscalChain)
  fiscalChain.maybeSingle.mockResolvedValue({ data: fiscalPeriod ?? null, error: null })
  const companySettingsChain = {
    select: vi.fn(), eq: vi.fn(), single: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>
  for (const method of ['select', 'eq']) companySettingsChain[method].mockReturnValue(companySettingsChain)
  companySettingsChain.single.mockResolvedValue({
    data: options.companySettingsError ? null : {
      org_number: options.orgNumber ?? '5560000000',
      entity_type: options.entityType ?? 'aktiebolag',
    },
    error: options.companySettingsError ?? null,
  })
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'fiscal_periods') return fiscalChain
      if (table === 'company_settings') return companySettingsChain
      throw new Error(`Unexpected table ${table}`)
    }),
  }
  return {
    ctx: {
      userId: 'user-1', companyId: 'company-1', extensionId: 'skatteverket', requestId: 'req-1',
      supabase, settings,
      emit: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    } as unknown as ExtensionContext,
    values,
    settings,
  }
}

function monthlyState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'draft_locked',
    redovisare: '165560000000',
    redovisningsperiod: '202606',
    periodType: 'monthly',
    year: 2026,
    period: 6,
    resolvedPeriodStart: '2026-06-01',
    resolvedPeriodEnd: '2026-06-30',
    fiscalPeriodId: null,
    fiscalPeriodStart: null,
    fiscalPeriodEnd: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function annualPrep(periodStart: string, periodEnd: string, fiscalPeriodId: string) {
  return {
    redovisare: '165560000000',
    redovisningsperiod: periodEnd.slice(0, 7).replace('-', ''),
    momsuppgift: { summaMoms: 0 },
    declaration: {
      period: {
        type: 'yearly' as const, year: Number(periodEnd.slice(0, 4)), period: 1,
        start: periodStart, end: periodEnd, fiscalPeriodId,
      },
      rutor,
    },
    fiscalPeriodId,
    resolvedPeriodStart: periodStart,
    resolvedPeriodEnd: periodEnd,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireCapability.mockResolvedValue(null)
  mocks.findRcBasisGaps.mockResolvedValue([])
  mocks.completeTaxDeadline.mockResolvedValue({ completed: 1 })
  mocks.resolveReadAuth.mockResolvedValue({ ok: true, auth: {}, tokenUserId: null })
})

describe('direct VAT declaration routes', () => {
  it.each([
    { method: 'GET', path: '/declaration/draft', remote: 'session' },
    { method: 'GET', path: '/declaration/submitted', remote: 'resolved' },
    { method: 'GET', path: '/declaration/decided', remote: 'resolved' },
  ])('rejects another represented organisation on $method $path before remote read', async ({ method, path }) => {
    const { ctx, values } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route(method, path).handler(new Request(
      `https://test.local${path}?redovisare=165599999999&redovisningsperiod=202606`,
      { method },
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(mocks.skvRequestWithAuth).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it('rejects another represented organisation before remote draft delete or local clear', async () => {
    const { ctx, values, settings } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route('DELETE', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165599999999&redovisningsperiod=202606',
      { method: 'DELETE' },
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(settings.clear).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing', stored: null, settingsGetError: undefined },
    { label: 'malformed', stored: JSON.stringify({ status: 'draft_locked' }), settingsGetError: undefined },
    { label: 'query error', stored: null, settingsGetError: new Error('extension_data unavailable') },
  ])('fails closed on $label state before remote draft delete or local clear', async ({ stored, settingsGetError }) => {
    const { ctx, values, settings } = makeContext(undefined, { settingsGetError })
    if (stored) values.set('submission_202606', stored)

    const result = await route('DELETE', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165560000000&redovisningsperiod=202606',
      { method: 'DELETE' },
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(settings.clear).not.toHaveBeenCalled()
  })

  it.each([
    { path: '/declaration/submitted' },
    { path: '/declaration/decided' },
  ])('fails closed on missing state before remote status read or completion for $path', async ({ path }) => {
    const { ctx } = makeContext()

    const result = await route('GET', path).handler(new Request(
      `https://test.local${path}?redovisare=165560000000&redovisningsperiod=202606`,
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequestWithAuth).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'malformed', stored: JSON.stringify({ status: 'draft_locked' }), settingsGetError: undefined },
    { label: 'query error', stored: null, settingsGetError: new Error('extension_data unavailable') },
  ])('fails closed on $label state before submitted remote read or completion', async ({ stored, settingsGetError }) => {
    const { ctx, values } = makeContext(undefined, { settingsGetError })
    if (stored) values.set('submission_202606', stored)

    const result = await route('GET', '/declaration/submitted').handler(new Request(
      'https://test.local/declaration/submitted?redovisare=165560000000&redovisningsperiod=202606',
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequestWithAuth).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing', stored: null, settingsGetError: undefined },
    { label: 'malformed', stored: JSON.stringify({ status: 'draft_locked' }), settingsGetError: undefined },
    { label: 'query error', stored: null, settingsGetError: new Error('extension_data unavailable') },
    {
      label: 'stored company identity mismatch',
      stored: JSON.stringify(monthlyState({ redovisare: '165599999999' })),
      settingsGetError: undefined,
    },
  ])('fails closed on $label state before remote draft read', async ({ stored, settingsGetError }) => {
    const { ctx, values } = makeContext(undefined, { settingsGetError })
    if (stored) values.set('submission_202606', stored)

    const result = await route('GET', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165560000000&redovisningsperiod=202606',
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it('reads only the exact authoritative stored company draft', async () => {
    mocks.skvRequest.mockResolvedValue(response({ draft: 'found' }))
    const { ctx, values } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route('GET', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165560000000&redovisningsperiod=202606&periodType=monthly&year=2026&period=6',
    ), ctx)

    expect(result.status).toBe(200)
    expect(mocks.skvRequest).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'GET',
      '/utkast/165560000000/202606',
    )
  })

  it('rejects draft picker identity that disagrees with authoritative stored state', async () => {
    const { ctx, values } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route('GET', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165560000000&redovisningsperiod=202606&periodType=monthly&year=2026&period=5',
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
  })

  it('deletes only the authoritative stored company draft, then clears its exact state', async () => {
    mocks.skvRequest.mockResolvedValue(response(null, 204))
    const { ctx, values, settings } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route('DELETE', '/declaration/draft').handler(new Request(
      'https://test.local/declaration/draft?redovisare=165560000000&redovisningsperiod=202606',
      { method: 'DELETE' },
    ), ctx)

    expect(result.status).toBe(200)
    expect(mocks.skvRequest).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'DELETE',
      '/utkast/165560000000/202606',
    )
    expect(settings.clear).toHaveBeenCalledWith('submission_202606')
  })

  it('rejects picker identity that disagrees with authoritative stored state', async () => {
    const { ctx, values } = makeContext()
    values.set('submission_202606', JSON.stringify(monthlyState()))

    const result = await route('GET', '/declaration/submitted').handler(new Request(
      'https://test.local/declaration/submitted?redovisare=165560000000&redovisningsperiod=202606&periodType=monthly&year=2026&period=5',
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequestWithAuth).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it('rejects supplied annual fiscal bounds that disagree with authoritative stored state', async () => {
    const { ctx, values } = makeContext()
    values.set('submission_202603', JSON.stringify({
      status: 'draft_locked',
      redovisare: '165560000000',
      redovisningsperiod: '202603',
      periodType: 'yearly',
      year: 2026,
      period: 1,
      resolvedPeriodStart: '2026-01-01',
      resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId: 'fp-short',
      fiscalPeriodStart: '2026-01-01',
      fiscalPeriodEnd: '2026-03-31',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }))

    const result = await route('GET', '/declaration/decided').handler(new Request(
      'https://test.local/declaration/decided?redovisare=165560000000&redovisningsperiod=202603&fiscalPeriodStart=2025-01-01',
    ), ctx)

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequestWithAuth).not.toHaveBeenCalled()
    expect(mocks.completeTaxDeadline).not.toHaveBeenCalled()
  })

  it('fails closed before draft or state writes when RC evidence is unavailable', async () => {
    mocks.buildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000', redovisningsperiod: '202606', momsuppgift: {},
      declaration: {
        period: { type: 'monthly', year: 2026, period: 6, start: '2026-06-01', end: '2026-06-30' },
        rutor,
      },
      resolvedPeriodStart: '2026-06-01', resolvedPeriodEnd: '2026-06-30',
    })
    mocks.findRcBasisGaps.mockRejectedValue(new Error('evidence unavailable'))
    mocks.skvRequest.mockResolvedValue(response({ kontrollResultat: { status: 'OK' } }))
    const { ctx, settings } = makeContext()

    const result = await route('POST', '/declaration/draft').handler(
      new Request('https://test.local/declaration/draft', {
        method: 'POST', body: JSON.stringify({ periodType: 'monthly', year: 2026, period: 6 }),
      }),
      ctx,
    )

    expect(result.status).toBe(422)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('fails closed before a lock retry when exact-period RC evidence is unavailable', async () => {
    mocks.buildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000', redovisningsperiod: '202606', momsuppgift: {},
      declaration: {
        period: { type: 'monthly', year: 2026, period: 6, start: '2026-06-01', end: '2026-06-30' },
        rutor,
      },
      resolvedPeriodStart: '2026-06-01', resolvedPeriodEnd: '2026-06-30',
    })
    mocks.findRcBasisGaps.mockRejectedValue(new Error('evidence unavailable'))
    const { ctx, values, settings } = makeContext()
    values.set('submission_202606', JSON.stringify({
      status: 'draft_saved', redovisare: '165560000000', redovisningsperiod: '202606',
      periodType: 'monthly', year: 2026, period: 6,
      resolvedPeriodStart: '2026-06-01', resolvedPeriodEnd: '2026-06-30',
      fiscalPeriodId: null, fiscalPeriodStart: null, fiscalPeriodEnd: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    }))

    const result = await route('PUT', '/declaration/lock').handler(new Request(
      'https://test.local/declaration/lock?redovisare=165560000000&redovisningsperiod=202606',
      { method: 'PUT' },
    ), ctx)

    expect(result.status).toBe(422)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(settings.set).not.toHaveBeenCalled()
  })

  it('preserves a short annual identity through save, lock retry, and receipt completion', async () => {
    const prep = annualPrep('2026-01-01', '2026-03-31', 'fp-short')
    mocks.buildMomsuppgift.mockResolvedValue(prep)
    mocks.skvRequest
      .mockResolvedValueOnce(response({ kontrollResultat: { status: 'OK' } }))
      .mockResolvedValueOnce(response({ signeringsLank: 'https://skv.test/sign/1' }))
      .mockResolvedValueOnce(response({ signeringsLank: 'https://skv.test/sign/2' }))
    mocks.skvRequestWithAuth.mockResolvedValue(response({ kvittensnummer: 'kv-1' }))
    const { ctx, values } = makeContext({
      id: 'fp-short', period_start: '2026-01-01', period_end: '2026-03-31',
    })

    const save = await route('POST', '/declaration/draft').handler(
      new Request('https://test.local/declaration/draft', {
        method: 'POST',
        body: JSON.stringify({
          periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId: 'fp-short',
        }),
      }),
      ctx,
    )
    expect(save.status).toBe(200)
    const key = 'submission_202603'
    expect(JSON.parse(values.get(key)!)).toMatchObject({
      periodType: 'yearly', year: 2026, period: 1,
      resolvedPeriodStart: '2026-01-01', resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId: 'fp-short',
    })

    const lockUrl = 'https://test.local/declaration/lock?redovisare=165560000000&redovisningsperiod=202603'
    expect((await route('PUT', '/declaration/lock').handler(new Request(lockUrl, { method: 'PUT' }), ctx)).status).toBe(200)
    expect((await route('PUT', '/declaration/lock').handler(new Request(lockUrl, { method: 'PUT' }), ctx)).status).toBe(200)
    expect(JSON.parse(values.get(key)!)).toMatchObject({
      status: 'draft_locked', periodType: 'yearly', year: 2026, period: 1,
      resolvedPeriodStart: '2026-01-01', resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId: 'fp-short',
    })

    const receipt = await route('GET', '/declaration/submitted').handler(
      new Request('https://test.local/declaration/submitted?redovisare=165560000000&redovisningsperiod=202603'),
      ctx,
    )
    expect(receipt.status).toBe(200)
    expect(mocks.completeTaxDeadline).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'moms_yearly',
      '2026-01-01/2026-03-31',
      'submitted',
      {
        fiscalPeriodId: 'fp-short',
        fiscalPeriodStart: '2026-01-01',
        fiscalPeriodEnd: '2026-03-31',
      },
    )
  })

  it('keeps an extended annual identity when a lock is retried', async () => {
    const prep = annualPrep('2025-07-01', '2026-12-31', 'fp-extended')
    mocks.buildMomsuppgift.mockResolvedValue(prep)
    mocks.skvRequest
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ signeringsLank: 'https://skv.test/sign/extended' }))
    const { ctx, values } = makeContext()

    await route('POST', '/declaration/draft').handler(new Request('https://test.local/declaration/draft', {
      method: 'POST',
      body: JSON.stringify({
        periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId: 'fp-extended',
      }),
    }), ctx)
    await route('PUT', '/declaration/lock').handler(new Request(
      'https://test.local/declaration/lock?redovisare=165560000000&redovisningsperiod=202612',
      { method: 'PUT' },
    ), ctx)

    expect(JSON.parse(values.get('submission_202612')!)).toMatchObject({
      fiscalPeriodId: 'fp-extended',
      resolvedPeriodStart: '2025-07-01',
      resolvedPeriodEnd: '2026-12-31',
    })
  })

  it('fails closed on same-end-year annual ambiguity before any draft write', async () => {
    mocks.buildMomsuppgift.mockRejectedValue(
      new Error('Multiple fiscal periods end in 2026; fiscal_period_id is required'),
    )
    const { ctx, settings } = makeContext()

    const result = await route('POST', '/declaration/draft').handler(
      new Request('https://test.local/declaration/draft', {
        method: 'POST',
        body: JSON.stringify({ periodType: 'yearly', year: 2026, period: 1 }),
      }),
      ctx,
    )

    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(mocks.skvRequest).not.toHaveBeenCalled()
    expect(settings.set).not.toHaveBeenCalled()
  })

  it.each([
    { path: '/declaration/submitted', status: 'submitted' as const },
    { path: '/declaration/decided', status: 'confirmed' as const },
  ])('binds $path completion to stored identity when supplied picker values agree', async ({ path, status }) => {
    const { ctx, values } = makeContext()
    values.set('submission_202606', JSON.stringify({
      status: 'draft_locked',
      redovisare: '165560000000',
      redovisningsperiod: '202606',
      periodType: 'monthly',
      year: 2026,
      period: 6,
      resolvedPeriodStart: '2026-06-01',
      resolvedPeriodEnd: '2026-06-30',
      fiscalPeriodId: null,
      fiscalPeriodStart: null,
      fiscalPeriodEnd: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    }))
    mocks.skvRequestWithAuth.mockResolvedValue(response({ filing: 'found' }))

    const result = await route('GET', path).handler(new Request(
      `https://test.local${path}?redovisare=165560000000&redovisningsperiod=202606&periodType=monthly&year=2026&period=6`,
    ), ctx)

    expect(result.status).toBe(200)
    expect(mocks.completeTaxDeadline).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'moms_monthly',
      '2026-06',
      status,
      undefined,
    )
  })
})
