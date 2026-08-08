import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const bulkBookMatchedInboxItemsMock = vi.fn()

vi.mock('@/lib/transactions/categorize-core', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transactions/categorize-core')>(
    '@/lib/transactions/categorize-core',
  )
  return {
    ...actual,
    bulkBookMatchedInboxItems: (...args: unknown[]) => bulkBookMatchedInboxItemsMock(...args),
  }
})

import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'

function buildCtx(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: {} as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

describe('POST /items/bulk-book', () => {
  const route = invoiceInboxExtension.apiRoutes!.find(
    (candidate) => candidate.method === 'POST' && candidate.path === '/items/bulk-book',
  )!

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serializes stable original and reversal ids for a partial item failure', async () => {
    const postedIds = {
      journal_entry_id: 'je-original',
      reversal_journal_entry_id: 'je-reversal',
    }
    bulkBookMatchedInboxItemsMock.mockResolvedValueOnce({
      booked: [],
      skipped: [
        {
          item_id: '11111111-1111-4111-8111-111111111111',
          reason: 'error',
          detail: 'Compensation could not be verified',
          partial_posted_ids: postedIds,
        },
      ],
      partial_posted_ids: postedIds,
    })
    const request = createMockRequest('/items/bulk-book', {
      method: 'POST',
      body: {
        item_ids: ['11111111-1111-4111-8111-111111111111'],
        category: 'expense_software',
      },
    })

    const response = await route.handler(request, buildCtx())
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({
      data: {
        booked_count: 0,
        skipped_count: 1,
        booked: [],
        skipped: [
          {
            item_id: '11111111-1111-4111-8111-111111111111',
            reason: 'error',
            detail: 'Compensation could not be verified',
            partial_posted_ids: postedIds,
          },
        ],
        partial_posted_ids: postedIds,
      },
    })
  })
})
