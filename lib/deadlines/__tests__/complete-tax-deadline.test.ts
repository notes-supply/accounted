import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { completeTaxDeadline } from '../complete-tax-deadline'

/**
 * Chain mock that records every builder call and resolves to the given
 * result when awaited (the helper ends the chain with .select('id')).
 */
function makeSupabase(result: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const method of ['update', 'eq', 'is', 'in', 'select', 'limit', 'contains', 'containedBy']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })

  const from = vi.fn(() => chain)
  return { supabase: { from } as unknown as SupabaseClient, from, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('completeTaxDeadline', () => {
  it('completes one exact open system deadline', async () => {
    const { supabase, from, calls } = makeSupabase({
      data: [{ id: 'd1', is_completed: false, status: null }],
    })

    const result = await completeTaxDeadline(
      supabase, 'company-1', ['moms_monthly', 'moms_quarterly'], '2026-06', 'submitted',
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
    expect(eqArgs).toContainEqual(['tax_period', '2026-06'])
    expect(eqArgs).toContainEqual(['is_completed', false])
    expect(eqArgs).toContainEqual(['source', 'system'])
    expect(eqArgs).toContainEqual(['is_auto_generated', true])

    const inCall = calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['tax_deadline_type', ['moms_monthly', 'moms_quarterly']])
  })

  it('quarterly period string matches the generator format', async () => {
    const { supabase, calls } = makeSupabase({
      data: [{ id: 'd1', is_completed: false, status: null }],
    })

    await completeTaxDeadline(supabase, 'company-1', ['moms_quarterly'], '2026-Q2', 'confirmed')

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['tax_period', '2026-Q2'])
    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ status: 'confirmed' })
  })

  it('requires exact linked report identity when supplied', async () => {
    const linkedReportPeriod = {
      period_type: 'yearly',
      request_year: 2026,
      request_period: 1,
      fiscal_period_id: '11111111-1111-4111-8111-111111111111',
    }
    const { supabase, calls } = makeSupabase({
      data: [{ id: 'd1', is_completed: false, status: null }],
    })

    await completeTaxDeadline(
      supabase,
      'company-1',
      ['moms_yearly'],
      '2026',
      'confirmed',
      linkedReportPeriod,
    )

    expect(calls.find((call) => call.method === 'contains')?.args)
      .toEqual(['linked_report_period', linkedReportPeriod])
    expect(calls.find((call) => call.method === 'containedBy')?.args)
      .toEqual(['linked_report_period', linkedReportPeriod])
  })

  it('treats an already completed exact deadline as an idempotent success', async () => {
    const { supabase, calls } = makeSupabase({
      data: [{ id: 'd1', is_completed: true, status: 'confirmed' }],
    })

    await expect(completeTaxDeadline(
      supabase, 'company-1', ['moms_monthly'], '2026-06', 'submitted',
    )).resolves.toEqual({ completed: 1 })
    expect(calls.some((call) => call.method === 'update')).toBe(false)
  })

  it('promotes an already submitted exact deadline to confirmed', async () => {
    const { supabase, calls } = makeSupabase({
      data: [{ id: 'd1', is_completed: true, status: 'submitted' }],
    })

    await expect(completeTaxDeadline(
      supabase, 'company-1', ['moms_monthly'], '2026-06', 'confirmed',
    )).resolves.toEqual({ completed: 1 })
    expect(calls.find((call) => call.method === 'update')?.args[0]).toMatchObject({
      is_completed: true,
      status: 'confirmed',
    })
  })

  it('fails closed when more than one deadline matches', async () => {
    const { supabase, calls } = makeSupabase({
      data: [
        { id: 'd1', is_completed: false, status: null },
        { id: 'd2', is_completed: false, status: null },
      ],
    })

    await expect(completeTaxDeadline(
      supabase, 'company-1', ['moms_monthly'], '2026-06', 'submitted',
    )).resolves.toEqual({ completed: 0 })

    expect(calls.some((call) => call.method === 'update')).toBe(false)
  })

  it('is a no-op returning 0 when nothing matches', async () => {
    const { supabase } = makeSupabase({ data: [] })
    const result = await completeTaxDeadline(
      supabase, 'company-1', ['arbetsgivardeklaration'], '2026-01', 'submitted',
    )
    expect(result).toEqual({ completed: 0 })
  })

  it('swallows DB errors: logs and returns 0, never throws', async () => {
    const { supabase } = makeSupabase({ error: { message: 'permission denied' } })
    await expect(
      completeTaxDeadline(supabase, 'company-1', ['moms_monthly'], '2026-06', 'submitted'),
    ).resolves.toEqual({ completed: 0 })
  })
})
