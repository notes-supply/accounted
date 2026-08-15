import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGenerateLedger = vi.fn()
const mockGenerateReconciliation = vi.fn()
let routeContext: Record<string, unknown>

vi.mock('@/lib/reports/supplier-ledger', () => ({
  generateSupplierLedger: (...args: unknown[]) => mockGenerateLedger(...args),
}))
vi.mock('@/lib/reports/supplier-reconciliation', () => ({
  generateReconciliation: (...args: unknown[]) => mockGenerateReconciliation(...args),
}))
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (
    _operation: string,
    handler: (request: Request, context: Record<string, unknown>) => Promise<Response>,
  ) => (request: Request) => handler(request, routeContext),
}))

import { GET } from '../route'

function makeSupabase(periodEnd: string) {
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq']) query[method] = vi.fn(() => query)
  query.maybeSingle = vi.fn(async () => ({ data: { period_end: periodEnd }, error: null }))
  return { from: vi.fn(() => query) }
}

describe('GET supplier ledger report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const supabase = makeSupabase('2026-12-31')
    routeContext = { supabase, companyId: 'co-1' }
    mockGenerateLedger.mockResolvedValue({ entries: [] })
    mockGenerateReconciliation.mockResolvedValue({ is_reconciled: true })
  })

  it('resolves period_end once and passes the exact cutoff to both reports', async () => {
    const response = await GET(
      new Request('http://localhost/api/reports/supplier-ledger?period_id=period-1'),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(mockGenerateLedger).toHaveBeenCalledWith(
      expect.anything(),
      'co-1',
      '2026-12-31',
    )
    expect(mockGenerateReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      'co-1',
      'period-1',
      '2026-12-31',
    )
  })

  it('uses an explicit as_of_date consistently when a period is also supplied', async () => {
    await GET(
      new Request(
        'http://localhost/api/reports/supplier-ledger?period_id=period-1&as_of_date=2026-10-31',
      ),
      { params: Promise.resolve({}) },
    )

    expect(mockGenerateLedger).toHaveBeenCalledWith(expect.anything(), 'co-1', '2026-10-31')
    expect(mockGenerateReconciliation).toHaveBeenCalledWith(
      expect.anything(),
      'co-1',
      'period-1',
      '2026-10-31',
    )
  })
})
