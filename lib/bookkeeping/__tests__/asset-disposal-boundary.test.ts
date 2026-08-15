import { describe, expect, it, vi } from 'vitest'
import { commitAssetDisposal } from '@/lib/bookkeeping/engine'
import { AmbiguousJournalCommitError } from '@/lib/bookkeeping/errors'
import type { CommitAssetDisposalInput } from '@/lib/bookkeeping/engine'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

const input: CommitAssetDisposalInput = {
  asset_id: 'asset-1',
  expected_asset_updated_at: '2026-08-15T09:00:00.000Z',
  fiscal_period_id: 'period-1',
  disposal_type: 'sale',
  disposed_at: '2026-08-15',
  disposed_proceeds: 12_500,
  proceeds_vat: 2_500,
  vat_treatment: 'standard_25',
  current_depreciation: 500,
  jamkning_amount: 0,
  jamkning_direction: 'none',
  jamkning_remaining_years: null,
  jamkning_total_years: null,
  jamkning_original_input_vat: null,
  jamkning_original_deduction_percent: null,
  jamkning_new_deduction_percent: null,
}

function readbackChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(result)
  return chain
}

describe('asset disposal durable boundary', () => {
  it('passes the expected asset version and actor slots to the M7 RPC', async () => {
    const posted = {
      id: 'entry-1',
      company_id: 'co-1',
      status: 'posted',
      voucher_number: 9,
      lines: [],
    }
    const chain = readbackChain({ data: posted, error: null })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ journal_entry_id: 'entry-1', voucher_number: 9 }],
        error: null,
      }),
      from: vi.fn().mockReturnValue(chain),
    }

    await expect(
      commitAssetDisposal(
        supabase as never,
        'co-1',
        'user-1',
        'entry-1',
        input,
      ),
    ).resolves.toEqual(posted)

    expect(supabase.rpc).toHaveBeenCalledWith('commit_asset_disposal', {
      p_company_id: 'co-1',
      p_asset_id: 'asset-1',
      p_entry_id: 'entry-1',
      p_expected_asset_updated_at: '2026-08-15T09:00:00.000Z',
      p_fiscal_period_id: 'period-1',
      p_disposal_type: 'sale',
      p_disposed_at: '2026-08-15',
      p_disposed_proceeds: 12_500,
      p_proceeds_vat: 2_500,
      p_vat_treatment: 'standard_25',
      p_current_depreciation: 500,
      p_jamkning_amount: 0,
      p_jamkning_direction: 'none',
      p_jamkning_remaining_years: null,
      p_jamkning_total_years: null,
      p_jamkning_original_input_vat: null,
      p_jamkning_original_deduction_percent: null,
      p_jamkning_new_deduction_percent: null,
      p_actor_type: null,
      p_actor_label: null,
    })
    expect(chain.eq).toHaveBeenCalledWith('id', 'entry-1')
    expect(chain.eq).toHaveBeenCalledWith('company_id', 'co-1')
  })

  it('retains journal and voucher identity when both readbacks fail', async () => {
    const chain = readbackChain({
      data: null,
      error: { message: 'readback unavailable' },
    })
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ journal_entry_id: 'entry-1', voucher_number: 9 }],
        error: null,
      }),
      from: vi.fn().mockReturnValue(chain),
    }

    await expect(
      commitAssetDisposal(
        supabase as never,
        'co-1',
        'user-1',
        'entry-1',
        input,
      ),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_JOURNAL_COMMIT',
      journalEntryId: 'entry-1',
      voucherNumber: 9,
    } satisfies Partial<AmbiguousJournalCommitError>)
    expect(chain.single).toHaveBeenCalledTimes(2)
  })
})
