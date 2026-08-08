/**
 * Safety tests for the Skatteverket MCP tools (PR5).
 *
 * Five tools wrap the skatteverket extension lib: two read tools hit SKV live
 * (validate, status) and two submit tools stage high-risk ops whose commit
 * dispatches into the extension (covered separately in
 * lib/pending-operations/__tests__/skatteverket-executors.test.ts). The
 * cross-extension lib modules are mocked so no real SKV call is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP, findStageApproveConflict } from '@/lib/auth/api-keys'

const mockSkvRequest = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...a: unknown[]) => mockSkvRequest(...a) }
})

const mockBuildMomsuppgift = vi.fn()
const mockResolveRedovisare = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/declaration-prep', () => ({
  buildMomsuppgift: (...a: unknown[]) => mockBuildMomsuppgift(...a),
  resolveRedovisare: (...a: unknown[]) => mockResolveRedovisare(...a),
}))

const mockKvittenser = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/agi-client', () => ({
  agiGetKvittenser: (...a: unknown[]) => mockKvittenser(...a),
}))

// Audit writes are exercised in the extension; mock them out here so the test
// supabase queue only has to account for staging reads.
vi.mock('@/extensions/general/skatteverket/lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: vi.fn(async () => []),
}))

const mockCompleteTaxDeadline = vi.fn()
vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: (...args: unknown[]) => mockCompleteTaxDeadline(...args),
}))

import { tools } from '../server'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'

const validate = tools.find((t) => t.name === 'gnubok_vat_declaration_validate')!
const vatSubmit = tools.find((t) => t.name === 'gnubok_vat_declaration_submit')!
const vatStatus = tools.find((t) => t.name === 'gnubok_vat_declaration_status')!
const agiSubmit = tools.find((t) => t.name === 'gnubok_agi_submit')!
const agiStatus = tools.find((t) => t.name === 'gnubok_agi_status')!

const ALL = [validate, vatSubmit, vatStatus, agiSubmit, agiStatus]

let prevEnv: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  prevEnv = process.env.SKATTEVERKET_ENABLED
  process.env.SKATTEVERKET_ENABLED = 'true'
})
afterEach(() => {
  if (prevEnv === undefined) delete process.env.SKATTEVERKET_ENABLED
  else process.env.SKATTEVERKET_ENABLED = prevEnv
})

describe('Skatteverket tools: catalog', () => {
  it('registers all five tools', () => {
    expect(ALL.every(Boolean)).toBe(true)
  })

  it('has Title Case titles with the Swedish law term inline', () => {
    expect(validate.title).toBe('Validate VAT Declaration (Momsdeklaration)')
    expect(vatSubmit.title).toBe('Submit VAT Declaration (Momsdeklaration)')
    expect(agiSubmit.title).toBe('Submit AGI Declaration (Arbetsgivardeklaration)')
  })

  it('all are openWorldHint (external system); reads are read-only, submits are not', () => {
    for (const t of ALL) expect(t.annotations.openWorldHint).toBe(true)
    expect(validate.annotations.readOnlyHint).toBe(true)
    expect(vatStatus.annotations.readOnlyHint).toBe(true)
    expect(agiStatus.annotations.readOnlyHint).toBe(true)
    expect(vatSubmit.annotations.readOnlyHint).toBe(false)
    expect(agiSubmit.annotations.readOnlyHint).toBe(false)
  })
})

describe('Skatteverket tools: EXTENSION_DISABLED gate', () => {
  it('every tool throws EXTENSION_DISABLED with the env off, making zero SKV calls', async () => {
    delete process.env.SKATTEVERKET_ENABLED
    const { supabase } = createQueuedMockSupabase()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const t of ALL) {
      const args = t.name.includes('agi') ? { salary_run_id: 'sr-1' } : { period_type: 'monthly', year: 2025, period: 3 }
      let thrown: unknown
      try {
        await t.execute(args, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
      } catch (err) {
        thrown = err
      }
      expect((thrown as Error & { code?: string })?.code, t.name).toBe('EXTENSION_DISABLED')
    }
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockKvittenser).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('gnubok_vat_declaration_validate', () => {
  it('maps a SkatteverketAuthError(NOT_CONNECTED) to SKATTEVERKET_NOT_CONNECTED', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: {}, declaration: { rutor: {} } })
    mockSkvRequest.mockRejectedValue(new SkatteverketAuthError('ingen anslutning', 'NOT_CONNECTED'))
    const { supabase } = createQueuedMockSupabase()
    let thrown: unknown
    try {
      await validate.execute({ period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error & { code?: string })?.code).toBe('SKATTEVERKET_NOT_CONNECTED')
  })

  it('happy path returns kontrollresultat', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 }, declaration: { rutor: {} } })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK', resultat: [] }) })
    const { supabase } = createQueuedMockSupabase()
    const result = (await validate.execute(
      { period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { kontrollresultat: { status: string }; redovisningsperiod: string }
    expect(result.kontrollresultat.status).toBe('OK')
    expect(result.redovisningsperiod).toBe('202503')
    // Only /kontrollera was called: nothing was saved at SKV.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][3]).toMatch(/^\/kontrollera\//)
  })
})

describe('gnubok_vat_declaration_submit', () => {
  it.each([
    { period_type: 'monthly', year: 2025, period: 1.5 },
    { period_type: 'quarterly', year: 2025, period: 5 },
    { period_type: 'yearly', year: 2025, period: 2 },
    { period_type: 'monthly', year: '2e3', period: 1 },
  ])('rejects invalid period input without prep, SKV, or staging: $period_type $year $period', async (args) => {
    const { supabase, findCall } = createQueuedMockSupabase()

    await expect(vatSubmit.execute(
      args,
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )).rejects.toThrow()

    expect(mockBuildMomsuppgift).not.toHaveBeenCalled()
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('validates via /kontrollera then stages: never touches /utkast', async () => {
    mockBuildMomsuppgift.mockResolvedValue({ redovisare: '165560000000', redovisningsperiod: '202503', momsuppgift: { summaMoms: 100 }, declaration: { rutor: {} } })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK' }) })
    const { supabase, enqueue } = createQueuedMockSupabase()
    // stagePendingOperation: resolvePeriodStatusForDate (company_settings + fiscal_periods) then insert
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    const result = (await vatSubmit.execute(
      { period_type: 'monthly', year: 2025, period: 3 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; risk_level: string; preview: { commit_action: string } }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(result.preview.commit_action).toMatch(/signering/i)
    // Exactly one SKV call (the stage-time /kontrollera); no /utkast.
    expect(mockSkvRequest).toHaveBeenCalledTimes(1)
    expect(mockSkvRequest.mock.calls[0][3]).toMatch(/^\/kontrollera\//)
  })

  it('keeps the annual fiscal period id in filing prep, staged params, and the status next action', async () => {
    const fiscalPeriodId = '11111111-1111-4111-8111-111111111111'
    mockBuildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000',
      redovisningsperiod: '202603',
      momsuppgift: { summaMoms: 100 },
      declaration: { rutor: {} },
      fiscalPeriodId,
      resolvedPeriodStart: '2025-04-01',
      resolvedPeriodEnd: '2026-03-31',
    })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK' }) })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    const result = (await vatSubmit.execute({
      period_type: 'yearly',
      year: 2026,
      period: 1,
      fiscal_period_id: fiscalPeriodId,
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      next: { args: Record<string, unknown> }
    }

    expect(mockBuildMomsuppgift).toHaveBeenCalledWith(
      supabase,
      'company-1',
      { periodType: 'yearly', year: 2026, period: 1, fiscalPeriodId },
    )
    expect(result.next.args).toMatchObject({ fiscal_period_id: fiscalPeriodId })

    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      params: { fiscal_period_id: fiscalPeriodId },
    })
  })

  it('persists the resolved annual fiscal period when the caller omits the id', async () => {
    const fiscalPeriodId = '22222222-2222-4222-8222-222222222222'
    mockBuildMomsuppgift.mockResolvedValue({
      redovisare: '165560000000',
      redovisningsperiod: '202603',
      momsuppgift: { summaMoms: 100 },
      fiscalPeriodId,
      resolvedPeriodStart: '2025-10-01',
      resolvedPeriodEnd: '2026-03-31',
      declaration: { rutor: {} },
    })
    mockSkvRequest.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'OK' }) })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: { id: 'op-2' }, error: null })

    const result = (await vatSubmit.execute({
      period_type: 'yearly',
      year: 2026,
      period: 1,
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      preview: Record<string, unknown>
      next: { args: Record<string, unknown> }
    }

    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      params: {
        fiscal_period_id: fiscalPeriodId,
        resolved_period_start: '2025-10-01',
        resolved_period_end: '2026-03-31',
      },
    })
    expect(result.preview).toMatchObject({ fiscal_period_id: fiscalPeriodId })
    expect(result.next.args).toMatchObject({ fiscal_period_id: fiscalPeriodId })
  })

  it('does not stage when an omitted annual id is ambiguous within the end year', async () => {
    mockBuildMomsuppgift.mockRejectedValueOnce(
      new Error('Multiple fiscal periods end in 2026; fiscal_period_id is required'),
    )
    const { supabase, findCall } = createQueuedMockSupabase()

    await expect(vatSubmit.execute({
      period_type: 'yearly',
      year: 2026,
      period: 1,
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }))
      .rejects.toThrow(/Multiple fiscal periods/)

    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })
})

describe('gnubok_vat_declaration_status', () => {
  function monthlyState(overrides: Record<string, unknown> = {}) {
    return {
      status: 'draft_locked',
      redovisare: '165560000000',
      redovisningsperiod: '202506',
      periodType: 'monthly',
      year: 2025,
      period: 6,
      resolvedPeriodStart: '2025-06-01',
      resolvedPeriodEnd: '2025-06-30',
      fiscalPeriodId: null,
      fiscalPeriodStart: null,
      fiscalPeriodEnd: null,
      updatedAt: '2025-07-01T00:00:00.000Z',
      ...overrides,
    }
  }

  beforeEach(() => {
    mockResolveRedovisare.mockResolvedValue('165560000000')
    mockCompleteTaxDeadline.mockResolvedValue({ completed: 1 })
  })

  it.each([
    { period_type: 'monthly', year: 2025, period: 1.5 },
    { period_type: 'quarterly', year: 2025, period: 5 },
    { period_type: 'yearly', year: 2025, period: 2 },
    { period_type: 'monthly', year: '2025tail', period: 1 },
  ])('rejects invalid period input without identity or SKV reads: $period_type $year $period', async (args) => {
    const { supabase } = createQueuedMockSupabase()

    await expect(vatStatus.execute(
      args,
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )).rejects.toThrow()

    expect(mockResolveRedovisare).not.toHaveBeenCalled()
    expect(mockSkvRequest).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing state', stored: null, error: undefined },
    { label: 'malformed state', stored: { value: JSON.stringify({ status: 'draft_locked' }) }, error: undefined },
    { label: 'state query error', stored: null, error: { message: 'extension_data unavailable' } },
  ])('fails closed on $label before remote read or deadline completion', async ({ stored, error }) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: stored, error })

    await expect(vatStatus.execute({
      period_type: 'monthly', year: 2025, period: 6, state: 'submitted',
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })).rejects.toThrow()

    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'company redovisare drift',
      stored: monthlyState({ redovisare: '165599999999' }),
      args: { period_type: 'monthly', year: 2025, period: 6, state: 'submitted' },
    },
    {
      label: 'caller period drift',
      stored: monthlyState(),
      args: { period_type: 'monthly', year: 2025, period: 5, state: 'submitted' },
    },
    {
      label: 'malformed immutable period drift',
      stored: monthlyState({ period: 5 }),
      args: { period_type: 'monthly', year: 2025, period: 6, state: 'submitted' },
    },
  ])('fails closed on $label before remote read or deadline completion', async ({ stored, args }) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { value: JSON.stringify(stored) } })

    await expect(vatStatus.execute(
      args,
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )).rejects.toThrow()

    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
  })

  it('uses durable identity for the submitted read and deadline completion', async () => {
    mockSkvRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kvittensnummer: 'KV-2025-06' }),
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { value: JSON.stringify(monthlyState()) } })

    const result = await vatStatus.execute({
      period_type: 'monthly', year: 2025, period: 6, state: 'submitted',
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }) as {
      redovisningsperiod: string
      submitted: unknown
    }

    expect(result.redovisningsperiod).toBe('202506')
    expect(result.submitted).toEqual({ kvittensnummer: 'KV-2025-06' })
    expect(mockSkvRequest).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'GET',
      '/inlamnat/165560000000/202506',
    )
    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'moms_monthly',
      '2025-06',
      'submitted',
      undefined,
    )
    expect(findCalls('extension_data', 'eq')).toEqual(expect.arrayContaining([
      ['company_id', 'company-1'],
      ['extension_id', 'skatteverket'],
      ['key', 'submission_202506'],
    ]))
  })

  it('uses durable identity for the decided read and confirmed deadline completion', async () => {
    mockSkvRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ beslutsstatus: 'FASTSTALLD' }),
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { value: JSON.stringify(monthlyState()) } })

    await vatStatus.execute({
      period_type: 'monthly', year: 2025, period: 6, state: 'decided',
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })

    expect(mockSkvRequest).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'GET',
      '/beslutat/165560000000/202506',
    )
    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'moms_monthly',
      '2025-06',
      'confirmed',
      undefined,
    )
  })

  it('uses the selected annual fiscal period end month for the Skatteverket status key', async () => {
    const fiscalPeriodId = '11111111-1111-4111-8111-111111111111'
    mockResolveRedovisare.mockResolvedValue('165560000000')
    mockSkvRequest.mockResolvedValue({ ok: false, status: 404 })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: fiscalPeriodId, period_start: '2025-01-01', period_end: '2026-03-31' } })
    enqueue({ data: { vat_liability_start_date: null } })
    enqueue({ data: { value: JSON.stringify({
      status: 'draft_locked',
      redovisare: '165560000000',
      redovisningsperiod: '202603',
      periodType: 'yearly',
      year: 2026,
      period: 1,
      resolvedPeriodStart: '2025-01-01',
      resolvedPeriodEnd: '2026-03-31',
      fiscalPeriodId,
      fiscalPeriodStart: '2025-01-01',
      fiscalPeriodEnd: '2026-03-31',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }) } })
    enqueue({ data: {
      id: fiscalPeriodId,
      period_start: '2025-01-01',
      period_end: '2026-03-31',
    } })

    const result = (await vatStatus.execute({
      period_type: 'yearly',
      year: 2026,
      period: 1,
      fiscal_period_id: fiscalPeriodId,
      state: 'submitted',
    }, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      redovisningsperiod: string
    }

    expect(result.redovisningsperiod).toBe('202603')
    expect(mockSkvRequest.mock.calls[0][3]).toBe('/inlamnat/165560000000/202603')
  })
})

describe('gnubok_agi_submit', () => {
  it('stages from local preconditions with zero SKV calls', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } }) // salary_runs
    enqueue({ data: { id: 'decl-1', status: 'generated', xml_content: '<agi/>' } }) // agi_declarations
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // insert

    const result = (await agiSubmit.execute(
      { salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { staged: boolean; risk_level: string }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('high')
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(mockKvittenser).not.toHaveBeenCalled()
  })

  it('throws when no AGI XML exists yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'sr-1', status: 'booked', period_year: 2026, period_month: 3, payment_date: '2026-03-25' } })
    enqueue({ data: null }) // no agi_declarations row
    await expect(
      agiSubmit.execute({ salary_run_id: 'sr-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/AGI-underlag saknas/)
  })
})

describe('gnubok_agi_status: run-scoped filing state', () => {
  // The period-keyed extension_data record is shared by every salary run of
  // the month (a correction coexists with the run it corrects, migration
  // 20260414130000). The tool must resolve it per run via
  // lib/salary/agi-submission-state.ts, exactly like AGIPanel: a correction
  // run reports unfiled-for-this-run even though the ORIGINAL's record says
  // 'signed', so the filing action stays visible.
  const ORIGINAL_RECORD = {
    status: 'signed',
    kvittensnummer: 'KV-ORIG-1',
    salaryRunId: 'sr-original',
    signeradTid: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
  }

  function enqueueStatusReads(
    enqueue: (r: { data?: unknown; error?: unknown }) => void,
    run: Record<string, unknown>,
    record: Record<string, unknown> | null,
  ) {
    enqueue({ data: run }) // salary_runs
    enqueue({ data: record ? { value: JSON.stringify(record) } : null }) // extension_data
  }

  beforeEach(() => {
    mockResolveRedovisare.mockResolvedValue('165560000000')
    // Nothing retrievable live: the run-scoping under test is purely local.
    mockKvittenser.mockResolvedValue({ ok: false, status: 404 })
  })

  it('a correction run reports generated (unfiled) although the period record is the original run\'s signed receipt', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-correction',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: '2026-07-05T10:00:00Z',
      agi_submitted_at: null,
    }, ORIGINAL_RECORD)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-correction' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      filing_state: string
      kvittensnummer: string | null
      local_state: Record<string, unknown> | null
    }

    // The correction has its own XML but no submission of its own: the
    // original's receipt must not render it as filed.
    expect(result.filing_state).toBe('generated')
    expect(result.kvittensnummer).toBeNull()
    expect(result.local_state).toBeNull()
  })

  it('the run that owns the record reports signed with its kvittensnummer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-original',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: '2026-06-28T08:00:00Z',
      agi_submitted_at: '2026-07-01T09:00:00Z',
    }, ORIGINAL_RECORD)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-original' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      filing_state: string
      kvittensnummer: string | null
      local_state: Record<string, unknown> | null
    }

    expect(result.filing_state).toBe('signed')
    expect(result.kvittensnummer).toBe('KV-ORIG-1')
    expect(result.local_state).toMatchObject({ status: 'signed', salaryRunId: 'sr-original' })
  })

  it('a run with neither XML nor record reports none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueStatusReads(enqueue, {
      id: 'sr-fresh',
      period_year: 2026,
      period_month: 6,
      agi_generated_at: null,
      agi_submitted_at: null,
    }, null)

    const result = (await agiStatus.execute(
      { salary_run_id: 'sr-fresh' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { filing_state: string; kvittensnummer: string | null; local_state: unknown }

    expect(result.filing_state).toBe('none')
    expect(result.kvittensnummer).toBeNull()
    expect(result.local_state).toBeNull()
  })
})

describe('Skatteverket tools: scopes', () => {
  it('maps the five tools to the right scopes', () => {
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_validate).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_status).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_agi_status).toBe('compliance:read')
    expect(TOOL_SCOPE_MAP.gnubok_vat_declaration_submit).toBe('skatteverket:write')
    expect(TOOL_SCOPE_MAP.gnubok_agi_submit).toBe('skatteverket:write')
  })

  it('skatteverket:write is a staging scope → SoD conflict with approve', () => {
    expect(findStageApproveConflict(['skatteverket:write', 'pending_operations:approve'])).toBe('skatteverket:write')
    expect(findStageApproveConflict(['skatteverket:write'])).toBeNull()
  })
})
