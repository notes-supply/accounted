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

const validVatParams = () => ({
  period_type: 'monthly' as const,
  year: 2025,
  period: 3,
  redovisare: '165560000000',
  redovisningsperiod: '202503',
  fiscal_period_id: null,
  fiscal_period_start: null,
  fiscal_period_end: null,
  original_period_start: '2025-03-01',
  original_period_end: '2025-03-31',
  resolved_period_start: '2025-03-01',
  resolved_period_end: '2025-03-31',
  vat_liability_start_date: null,
  approved_rutor: APPROVED_RUTOR,
  approved_momsuppgift: { summaMoms: 0 },
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

    const op = makePendingOp({ params: validVatParams() })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ signing_url: 'https://skv.test/sign/abc', status: 'awaiting_signature' })
    expect(vat).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({
        ...validVatParams(),
        approved_rutor: APPROVED_RUTOR,
        approved_momsuppgift: { summaMoms: 0 },
      }),
    )
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

    const op = makePendingOp({ params: validVatParams() })
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

    const op = makePendingOp({ params: validVatParams() })
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

    const op = makePendingOp({ params: validVatParams() })
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
})
