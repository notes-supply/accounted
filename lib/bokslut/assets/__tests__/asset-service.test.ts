import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Asset, JournalEntry } from '@/types'

const { createDraftEntryMock, commitAssetDisposalMock } = vi.hoisted(() => ({
  createDraftEntryMock: vi.fn(),
  commitAssetDisposalMock: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: createDraftEntryMock,
  commitAssetDisposal: commitAssetDisposalMock,
}))

import { disposeAsset, type DisposeAssetInput } from '../asset-service'

const ASSET_VERSION = '2026-06-30T08:15:30.000Z'
const PERIOD = {
  id: '11111111-1111-4111-8111-111111111111',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
}
const INPUT: DisposeAssetInput = {
  disposal_type: 'sale',
  disposed_at: '2026-06-30',
  disposed_proceeds: 125_000,
  proceeds_account: '1930',
  fiscal_period_id: PERIOD.id,
  vat_treatment: 'standard_25',
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    user_id: 'user-1',
    company_id: 'company-1',
    name: 'Machine',
    category: 'equipment',
    acquisition_date: '2025-01-01',
    acquisition_cost: 100_000,
    salvage_value: 0,
    useful_life_months: 60,
    depreciation_method: 'linear',
    bas_asset_account: '1220',
    bas_accumulated_account: '1229',
    bas_expense_account: '7832',
    restvarde_target: null,
    disposed_at: null,
    disposed_proceeds: null,
    disposed_proceeds_vat: 0,
    disposed_vat_treatment: null,
    jamkning_amount: 0,
    jamkning_remaining_months: null,
    jamkning_total_months: null,
    jamkning_original_input_vat: null,
    k3_components: null,
    notes: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: ASSET_VERSION,
    ...overrides,
  }
}

const planner = createQueuedMockSupabase()
const committer = createQueuedMockSupabase()
const plannerClient = planner.supabase as unknown as SupabaseClient
const commitClient = committer.supabase as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  planner.reset()
  committer.reset()
})

function enqueuePlanningContext(asset = makeAsset()) {
  planner.enqueueMany([
    { data: asset },
    { data: [PERIOD] },
    { data: [] },
  ])
}

describe('disposeAsset version boundary', () => {
  it('plans with the authenticated client and binds the service commit to the loaded asset version', async () => {
    const asset = makeAsset()
    const updatedAsset = makeAsset({
      disposed_at: INPUT.disposed_at,
      disposal_journal_entry_id: 'entry-1',
    })
    const draft = { id: 'draft-1', status: 'draft' } as JournalEntry
    const posted = {
      id: 'entry-1',
      status: 'posted',
      voucher_number: 42,
    } as JournalEntry

    enqueuePlanningContext(asset)
    planner.enqueue({ data: updatedAsset })
    createDraftEntryMock.mockResolvedValue(draft)
    commitAssetDisposalMock.mockResolvedValue(posted)

    const result = await disposeAsset(
      { plannerClient, commitClient },
      'company-1',
      'user-1',
      asset.id,
      INPUT,
    )

    expect(createDraftEntryMock).toHaveBeenCalledWith(
      plannerClient,
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'system' }),
    )
    expect(commitAssetDisposalMock).toHaveBeenCalledWith(
      commitClient,
      'company-1',
      'user-1',
      draft.id,
      expect.objectContaining({
        asset_id: asset.id,
        expected_asset_updated_at: ASSET_VERSION,
      }),
    )
    expect(result.disposal_entry).toBe(posted)
    expect(result.asset).toBe(updatedAsset)
  })

  it('does not issue client-side fallback writes when the atomic commit fails', async () => {
    const asset = makeAsset()
    enqueuePlanningContext(asset)
    createDraftEntryMock.mockResolvedValue({ id: 'draft-1', status: 'draft' } as JournalEntry)
    commitAssetDisposalMock.mockRejectedValue(new Error('stale asset version'))

    await expect(
      disposeAsset(
        { plannerClient, commitClient },
        'company-1',
        'user-1',
        asset.id,
        INPUT,
      ),
    ).rejects.toThrow('stale asset version')

    expect(planner.supabase.from).not.toHaveBeenCalledWith('journal_entries')
    expect(committer.supabase.from).not.toHaveBeenCalled()
    expect(committer.supabase.rpc).not.toHaveBeenCalled()
  })
})
