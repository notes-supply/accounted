import { describe, expect, it, vi } from 'vitest'
import {
  DurableAccountingIdentityError,
  DurableAccountingPartialError,
} from '@/lib/bookkeeping/errors'
import { errorResponse, getStructuredError } from '@/lib/errors/get-structured-error'

const recovery = {
  company_id: 'co-1',
  original_journal_entry_id: 'entry-1',
  reversal_journal_entry_id: 'storno-1',
  publication_ids: ['publication-1', 'publication-2'],
}

const log = {
  error: vi.fn(),
  warn: vi.fn(),
}

describe('durable accounting structured errors', () => {
  it('marks a partial durable outcome non-retryable', () => {
    const error = new DurableAccountingPartialError(
      'apply_supplier_payment_reversal',
      recovery,
      'readback unavailable',
    )

    expect(getStructuredError(error)).toMatchObject({
      code: 'DURABLE_ACCOUNTING_PARTIAL',
      retryable: false,
    })
  })

  it('returns every exact recovery identity in the REST envelope', async () => {
    const error = new DurableAccountingIdentityError(
      'apply_supplier_payment_reversal',
      recovery,
      'contradictory publication identities',
    )
    const response = errorResponse(error, log)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'DURABLE_ACCOUNTING_IDENTITY_INVALID',
        details: {
          operation: 'apply_supplier_payment_reversal',
          company_id: 'co-1',
          original_journal_entry_id: 'entry-1',
          reversal_journal_entry_id: 'storno-1',
          publication_ids: ['publication-1', 'publication-2'],
        },
      },
    })
  })
})
