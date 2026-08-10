/**
 * Unit tests for commitSubmitVatDeclaration / commitSubmitAgi.
 * Driven through the public commitPendingOperation dispatcher.
 *
 * The MCP submit tools stage submit_vat_declaration / submit_agi ops; this
 * dispatcher resolves the skatteverket extension's commit services via the
 * registry and translates their SkvSubmitResult into the op lifecycle:
 *   - ok                    → committed (signing_url in result_data)
 *   - recoverable failure   → released back to 'pending' (re-approve works)
 *   - non-recoverable / SKV business error → rejected
 *
 * A FAKE extension is registered in the registry so no real SKV/extension
 * code runs: this isolates the core wiring (registry resolution + lifecycle).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { Extension } from '@/lib/extensions/types'
import type { SkvSubmitResult } from '@/lib/pending-operations/skatteverket-commit'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

// The commit-time capability gate (PR: gate paid MCP tools) runs hasCapability
// before the atomic claim for submit_vat_declaration/submit_agi. These tests
// isolate the registry/lifecycle wiring, so make the gate transparent here;
// its enforcement is covered by commit-capability-gate.test.ts.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'submit_vat_declaration',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

function registerFakeSkatteverket(
  services: Record<string, (...a: unknown[]) => Promise<SkvSubmitResult>>,
): void {
  extensionRegistry.register({
    id: 'skatteverket',
    name: 'fake-skatteverket',
    version: '0.0.0',
    services,
  } as unknown as Extension)
}

const MONTHLY_VAT_PARAMS = {
  period_type: 'monthly',
  year: 2025,
  period: 3,
  resolved_period_start: '2025-03-14',
  resolved_period_end: '2025-03-31',
}

const ANNUAL_VAT_PARAMS = {
  period_type: 'yearly',
  year: 2026,
  period: 1,
  vat_liability_start_date: '2025-10-01',
  fiscal_period_id: 'fp-1',
  fiscal_period_start: '2025-07-01',
  fiscal_period_end: '2026-03-31',
  resolved_period_start: '2025-10-01',
  resolved_period_end: '2026-03-31',
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})
afterEach(() => {
  extensionRegistry.clear()
})

describe('commitPendingOperation: submit_vat_declaration / submit_agi', () => {
  it('happy VAT path → committed with signing_url + awaiting_signature status', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: true, signing_url: 'https://skv.test/sign/abc', redovisningsperiod: '202503',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // dispatcher commit update

    const op = makePendingOp({ params: MONTHLY_VAT_PARAMS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ signing_url: 'https://skv.test/sign/abc', status: 'awaiting_signature' })
    expect(vat).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', {
      ...MONTHLY_VAT_PARAMS,
    })
  })

  it('stable annual fiscal identity is re-read and submitted unchanged', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: true, signing_url: 'https://skv.test/sign/annual', redovisningsperiod: '202603',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'fp-1', period_start: '2025-07-01', period_end: '2026-03-31' },
      error: null,
    })
    enqueue({ data: { vat_liability_start_date: '2025-10-01' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: ANNUAL_VAT_PARAMS }),
    )

    expect(result.status).toBe('committed')
    expect(vat).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', ANNUAL_VAT_PARAMS)
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['id', 'fp-1'])
    expect(findCalls('fiscal_periods', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it.each([
    {
      label: 'original start drift with unchanged liability-clamped bounds',
      fiscalPeriod: { id: 'fp-1', period_start: '2025-08-01', period_end: '2026-03-31' },
      vatStart: '2025-10-01',
      error: /fiscal period identity changed/i,
    },
    {
      label: 'original end drift',
      fiscalPeriod: { id: 'fp-1', period_start: '2025-07-01', period_end: '2026-04-30' },
      vatStart: '2025-10-01',
      error: /fiscal period identity changed/i,
    },
    {
      label: 'resolved liability bounds drift',
      fiscalPeriod: { id: 'fp-1', period_start: '2025-07-01', period_end: '2026-03-31' },
      vatStart: '2025-11-01',
      error: /VAT period changed since staging/i,
    },
  ])('rejects $label before submission', async ({ fiscalPeriod, vatStart, error }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: fiscalPeriod, error: null })
    enqueue({ data: { vat_liability_start_date: vatStart }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: ANNUAL_VAT_PARAMS }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(error)
    expect(vat).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'same-effective-bounds date drift',
      stagedVatStart: '2025-01-01',
      currentVatStart: '2025-02-01',
    },
    {
      label: 'null to date',
      stagedVatStart: null,
      currentVatStart: '2025-02-01',
    },
    {
      label: 'date to null',
      stagedVatStart: '2025-01-01',
      currentVatStart: null,
    },
  ])('rejects annual liability identity drift: $label', async ({
    stagedVatStart,
    currentVatStart,
  }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'fp-1', period_start: '2025-07-01', period_end: '2026-03-31' },
      error: null,
    })
    enqueue({ data: { vat_liability_start_date: currentVatStart }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          ...ANNUAL_VAT_PARAMS,
          vat_liability_start_date: stagedVatStart,
          resolved_period_start: '2025-07-01',
        },
      }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/VAT period changed since staging/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'missing', params: { ...ANNUAL_VAT_PARAMS, vat_liability_start_date: undefined } },
    { label: 'malformed', params: { ...ANNUAL_VAT_PARAMS, vat_liability_start_date: '2025-02-30' } },
  ])('rejects $label staged annual liability evidence', async ({ params }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/liability start identity/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it('rejects a staged annual year that conflicts with the authoritative fiscal end year', async () => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({
      data: { id: 'fp-1', period_start: '2025-07-01', period_end: '2026-03-31' },
      error: null,
    })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { ...ANNUAL_VAT_PARAMS, year: 2025 } }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/fiscal period identity conflict/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'missing original bounds',
      params: {
        ...ANNUAL_VAT_PARAMS,
        fiscal_period_start: undefined,
        fiscal_period_end: undefined,
      },
    },
    {
      label: 'one-sided original bounds',
      params: { ...ANNUAL_VAT_PARAMS, fiscal_period_end: undefined },
    },
    {
      label: 'malformed original bounds',
      params: { ...ANNUAL_VAT_PARAMS, fiscal_period_start: '2025-02-30' },
    },
  ])('rejects annual operation with $label before submission', async ({ params }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/fiscal period identity/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'cross-company missing period',
      fiscalRead: { data: null, error: null },
    },
    {
      label: 'ambiguous period read',
      fiscalRead: {
        data: null,
        error: { message: 'JSON object requested, multiple rows returned', code: 'PGRST116' },
      },
    },
  ])('rejects $label before submission', async ({ fiscalRead }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue(fiscalRead)
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: ANNUAL_VAT_PARAMS }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/fiscal period identity/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it('happy AGI path → committed with signing_url', async () => {
    const agi = vi.fn().mockResolvedValue({ ok: true, signing_url: 'https://skv.test/agi/xyz', period: '202503' })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vi.fn(), commitSubmitAgi: agi })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ operation_type: 'submit_agi', params: { salary_run_id: 'sr-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ signing_url: 'https://skv.test/agi/xyz' })
    expect(agi).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', { salary_run_id: 'sr-1' })
  })

  it('no service registered → failed EXTENSION_DISABLED, op released to pending', async () => {
    // registry is empty (afterEach cleared it; nothing registered here)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // release-to-pending update

    const op = makePendingOp({ params: MONTHLY_VAT_PARAMS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('EXTENSION_DISABLED')
    expect(result.http_status).toBe(503)
  })

  it('recoverable service result → released to pending with the structured code', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', http_status: 401, recoverable: true, error: 'no connection',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // release-to-pending update

    const op = makePendingOp({ params: MONTHLY_VAT_PARAMS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('SKATTEVERKET_NOT_CONNECTED')
    expect(result.http_status).toBe(401)
  })

  it('non-recoverable service result → op rejected (consumed)', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 400, recoverable: false, error: 'SKV rejected the draft',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: MONTHLY_VAT_PARAMS })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/rejected/i)
  })

  it('missing params → 400 without resolving the extension service', async () => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: { year: 2025 } }) // missing period_type + period
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(vat).not.toHaveBeenCalled()
  })

  it('rejects a tampered staged VAT period before resolving the extension service', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: true,
      signing_url: 'https://skv.test/should-not-be-used',
      redovisningsperiod: '202501',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      params: { period_type: 'monthly', year: 2025, period: 1.5 },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(vat).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'absent', bounds: {} },
    { label: 'start only', bounds: { resolved_period_start: '2025-03-14' } },
    { label: 'end only', bounds: { resolved_period_end: '2025-03-31' } },
    {
      label: 'malformed start',
      bounds: { resolved_period_start: '2025-02-30', resolved_period_end: '2025-03-31' },
    },
    {
      label: 'malformed end',
      bounds: { resolved_period_start: '2025-03-14', resolved_period_end: '2025-13-31' },
    },
    {
      label: 'reversed',
      bounds: { resolved_period_start: '2025-04-01', resolved_period_end: '2025-03-31' },
    },
  ])('rejects $label staged VAT bounds before resolving the extension service', async ({ bounds }) => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })
    const op = makePendingOp({
      params: { period_type: 'monthly', year: 2025, period: 3, ...bounds },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/resolved period bounds/i)
    expect(vat).not.toHaveBeenCalled()
  })

  it('rejects a legacy yearly operation without an immutable fiscal period id', async () => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      params: { period_type: 'yearly', year: 2026, period: 1 },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/fiscal_period_id/)
    expect(vat).not.toHaveBeenCalled()
  })

  it('rejects a yearly operation that has an id but lacks staged bounds', async () => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      params: {
        period_type: 'yearly',
        year: 2026,
        period: 1,
        fiscal_period_id: 'fp-1',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/resolved period bounds/)
    expect(vat).not.toHaveBeenCalled()
  })
})
