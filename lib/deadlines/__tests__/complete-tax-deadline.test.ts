import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { completeTaxDeadline } from '../complete-tax-deadline'

/**
 * Chain mock that records every builder call and resolves to the given
 * result when awaited (the helper ends the chain with .select('id')).
 */
function makeSupabase(
  resultOrResults:
    | { data?: unknown; error?: unknown }
    | Array<{ data?: unknown; error?: unknown }>,
) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const results = Array.isArray(resultOrResults) ? [...resultOrResults] : [resultOrResults]
  const from = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    for (const method of ['update', 'eq', 'in', 'is', 'contains', 'select', 'limit']) {
      chain[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args })
        return chain
      })
    }
    chain.then = (resolve: (v: unknown) => void) => {
      const result = results.shift() ?? {}
      resolve({ data: result.data ?? null, error: result.error ?? null })
    }
    return chain
  })
  return { supabase: { from } as unknown as SupabaseClient, from, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('completeTaxDeadline', () => {
  it('completes only the exact active system tax deadline and returns one', async () => {
    const { supabase, from, calls } = makeSupabase([
      { data: [{ id: 'd1' }] },
      { data: [{ id: 'd1' }] },
    ])

    const result = await completeTaxDeadline(
      supabase, 'company-1', 'moms_monthly', '2026-06', 'submitted',
    )

    expect(result).toEqual({ completed: 1 })
    expect(from).toHaveBeenCalledWith('deadlines')

    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({
      is_completed: true,
      status: 'submitted',
    })
    expect((updateCall?.args[0] as Record<string, unknown>).completed_at).toBeTruthy()

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
    expect(eqArgs).toContainEqual(['deadline_type', 'tax'])
    expect(eqArgs).toContainEqual(['source', 'system'])
    expect(eqArgs).toContainEqual(['tax_deadline_type', 'moms_monthly'])
    expect(eqArgs).toContainEqual(['tax_period', '2026-06'])
    expect(eqArgs).toContainEqual(['is_completed', false])
    expect(calls).toContainEqual({ method: 'is', args: ['dismissed_at', null] })
  })

  it('quarterly period string matches the generator format', async () => {
    const { supabase, calls } = makeSupabase({ data: [{ id: 'd1' }] })

    await completeTaxDeadline(supabase, 'company-1', 'moms_quarterly', '2026-Q2', 'confirmed')

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['tax_period', '2026-Q2'])
    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ status: 'confirmed' })
  })

  it('scopes yearly completion to the exact fiscal-period identity', async () => {
    const { supabase, calls } = makeSupabase({ data: [{ id: 'd1' }] })

    await completeTaxDeadline(
      supabase,
      'company-1',
      'moms_yearly',
      '2026-01-01/2026-03-31',
      'confirmed',
      {
        fiscalPeriodId: 'fp-short',
        fiscalPeriodStart: '2026-01-01',
        fiscalPeriodEnd: '2026-03-31',
      },
    )

    expect(calls).toContainEqual({
      method: 'contains',
      args: ['linked_report_period', {
        fiscalPeriodId: 'fp-short',
        fiscalPeriodStart: '2026-01-01',
        fiscalPeriodEnd: '2026-03-31',
      }],
    })
  })

  it('is a no-op returning 0 when nothing matches', async () => {
    const { supabase } = makeSupabase({ data: [] })
    const result = await completeTaxDeadline(
      supabase, 'company-1', 'arbetsgivardeklaration', '2026-01', 'submitted',
    )
    expect(result).toEqual({ completed: 0 })
  })

  it('swallows DB errors: logs and returns 0, never throws', async () => {
    const { supabase } = makeSupabase({ error: { message: 'permission denied' } })
    await expect(
      completeTaxDeadline(supabase, 'company-1', 'moms_monthly', '2026-06', 'submitted'),
    ).resolves.toEqual({ completed: 0 })
  })

  it('fails closed without updating when more than one exact row matches', async () => {
    const { supabase, calls } = makeSupabase({ data: [{ id: 'd1' }, { id: 'd2' }] })

    await expect(
      completeTaxDeadline(supabase, 'company-1', 'moms_monthly', '2026-06', 'confirmed'),
    ).resolves.toEqual({ completed: 0 })

    expect(calls.filter((call) => call.method === 'update')).toHaveLength(0)
  })

  it('returns zero when the guarded row is no longer active at update time', async () => {
    const { supabase } = makeSupabase([
      { data: [{ id: 'd1' }] },
      { data: [] },
    ])

    await expect(
      completeTaxDeadline(supabase, 'company-1', 'moms_monthly', '2026-06', 'confirmed'),
    ).resolves.toEqual({ completed: 0 })
  })
})
