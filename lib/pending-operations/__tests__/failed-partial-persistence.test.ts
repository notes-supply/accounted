import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { persistFailedPartialState } from '../commit'

const input = {
  operationId: 'op-1',
  companyId: 'company-1',
  error: 'attachment failed after posting',
  postedIds: { journal_entry_id: 'je-1' },
  threw: true,
}

function failedPartialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    company_id: 'company-1',
    status: 'failed_partial',
    result_data: { posted_ids: { journal_entry_id: 'je-1' } },
    ...overrides,
  }
}

describe('persistFailedPartialState', () => {
  it('confirms an authoritative CAS update scoped by id, company, and committing status', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: failedPartialRow(), error: null })

    await expect(
      persistFailedPartialState(supabase as never, input),
    ).resolves.toEqual({
      persistence: 'confirmed',
      operation_status: 'failed_partial',
    })

    expect(findCalls('pending_operations', 'eq')).toEqual([
      ['id', 'op-1'],
      ['company_id', 'company-1'],
      ['status', 'committing'],
    ])
  })

  it('reports a database error and the authoritative committing state', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'write timeout' } })
    enqueue({
      data: {
        id: 'op-1',
        company_id: 'company-1',
        status: 'committing',
        result_data: { commit_in_progress: { partial_failure_possible: true } },
      },
      error: null,
    })

    await expect(
      persistFailedPartialState(supabase as never, input),
    ).resolves.toEqual({
      persistence: 'database_error',
      operation_status: 'committing',
    })
  })

  it('reports a concurrent status conflict without claiming failed_partial', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    enqueue({ data: failedPartialRow({ status: 'committed' }), error: null })

    await expect(
      persistFailedPartialState(supabase as never, input),
    ).resolves.toEqual({
      persistence: 'conflict',
      operation_status: 'other',
    })
  })

  it('cannot verify a row belonging to another tenant', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    await expect(
      persistFailedPartialState(supabase as never, input),
    ).resolves.toEqual({
      persistence: 'conflict',
      operation_status: 'unknown',
    })

    expect(findCalls('pending_operations', 'eq')).toEqual([
      ['id', 'op-1'],
      ['company_id', 'company-1'],
      ['status', 'committing'],
      ['id', 'op-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('accepts an authoritative read only when it proves the same posted ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'response lost' } })
    enqueue({ data: failedPartialRow(), error: null })

    await expect(
      persistFailedPartialState(supabase as never, input),
    ).resolves.toEqual({
      persistence: 'confirmed',
      operation_status: 'failed_partial',
    })
  })
})
