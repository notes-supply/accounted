import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'

const { supabase: mockSupabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCategorizeMatchedTransaction = vi.fn()
vi.mock('@/lib/transactions/categorize-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    categorizeMatchedTransaction: (...args: unknown[]) =>
      mockCategorizeMatchedTransaction(...args),
  }
})

const canonicalLines = [
  {
    account_number: '6110',
    debit_amount: 500,
    credit_amount: 0,
    line_description: 'Test',
    dimensions: {},
  },
  {
    account_number: '1930',
    debit_amount: 0,
    credit_amount: 500,
    line_description: 'Test',
    dimensions: {},
  },
]
vi.mock('@/lib/bookkeeping/transaction-entries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    buildTransactionEntryLines: vi.fn(() => canonicalLines),
  }
})

// Mock VAT validation
vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: vi.fn().mockResolvedValue({ valid: true }),
}))

// Mock exchange rate
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue({ rate: 11.5, date: '2026-03-25' }),
  convertToSEK: vi.fn((amount: number, rate: number) => Math.round(amount * rate * 100) / 100),
}))

import { POST } from '../../commit/route'

describe('POST /api/pending-operations/:id/commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const routeParams = createMockRouteParams({ id: 'op-1' })

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockCategorizeMatchedTransaction.mockResolvedValue({
      data: { journal_entry_id: 'je-1' },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when operation not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('not found')
  })

  it('returns 409 when operation already committed', async () => {
    enqueue({
      data: {
        id: 'op-1',
        user_id: 'user-1',
        operation_type: 'categorize_transaction',
        status: 'committed',
        params: {},
        preview_data: {},
      },
    })
    enqueue({ data: null, error: null }) // CAS UPDATE returns 0 rows since status != 'pending'

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(409)
    // The executor's English error string maps to the Swedish HTTP-409
    // fallback: raw English never reaches the toast (issue #337).
    expect(body.error).toBe('En konflikt uppstod. Ladda om sidan och försök igen.')
  })

  describe('categorize_transaction', () => {
    const settlementSnapshot = {
      companyId: 'company-1',
      transactionId: 'tx-1',
      expectedJournalEntryId: null,
      cashAccountId: null,
      settlementAccount: '1930',
      amountSek: 500,
      category: 'expense_office',
      isBusiness: true,
      lines: canonicalLines,
    }

    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'categorize_transaction',
      status: 'pending',
      title: 'Kategorisera: test',
      params: {
        transaction_id: 'tx-1',
        category: 'expense_office',
        vat_treatment: null,
        settlement_snapshot: settlementSnapshot,
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })

      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                // verify approved settlement snapshot
        { data: null, error: null },                 // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string } }>(response)

      expect(status).toBe(200)
      expect(body.data.journal_entry_id).toBe('je-1')
      expect(mockCategorizeMatchedTransaction).toHaveBeenCalledTimes(1)
      expect(mockCategorizeMatchedTransaction).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'company-1',
        'tx-1',
        expect.objectContaining({
          approvedSettlementSnapshot: settlementSnapshot,
        }),
      )
    })

    it('rejects when the linked cash account resolves to a different ledger at commit', async () => {
      const tx = makeTransaction({
        id: 'tx-1',
        amount: -500,
        cash_account_id: 'cash-1',
        journal_entry_id: null,
      })
      const driftedOp = {
        ...pendingOp,
        params: {
          ...pendingOp.params,
          settlement_snapshot: {
            ...settlementSnapshot,
            cashAccountId: 'cash-1',
            settlementAccount: '1931',
          },
        },
      }

      enqueueMany([
        { data: driftedOp },                         // fetch pending op
        { data: { id: 'op-1' } },                   // CAS claim
        { data: tx },                                // verify approved settlement snapshot
        { data: { entity_type: 'aktiebolag' } },      // current mapping settings
        { data: { ledger_account: '1932' } },        // current linked cash-account ledger
        { data: null, error: null },                 // auto-reject update
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(409)
      expect(body.error).toBe('En konflikt uppstod. Ladda om sidan och försök igen.')
      expect(mockCategorizeMatchedTransaction).not.toHaveBeenCalled()
    })

    it('returns the structured ACCOUNTS_NOT_IN_CHART envelope when the chart lacks accounts', async () => {
      // The booking is valid but posts to reverse-charge accounts (2614/2645)
      // not active in the chart. The engine throws AccountsNotInChartError; the
      // dispatcher must release the op back to 'pending' (retryable, see the
      // 6th enqueued response) and the route must return the structured error
      // with code + account_numbers so the chat can offer activation: NOT a
      // raw error string.
      const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
      mockCategorizeMatchedTransaction.mockRejectedValueOnce(
        new AccountsNotInChartError(['2645', '2614']),
      )

      enqueueMany([
        { data: pendingOp },                         // route fetch op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                // verify approved settlement snapshot
        { data: null, error: null },                 // release op back to pending
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{
        error: { code: string; account_numbers: string[] }
      }>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      // Numeric sort puts 2614 before 2645 regardless of input order.
      expect(body.error.account_numbers).toEqual(['2614', '2645'])
    })

    it('returns 409 when transaction already categorized', async () => {
      const existingJournalEntryId = '33333333-3333-4333-8333-333333333333'
      const tx = makeTransaction({
        id: 'tx-1',
        amount: -500,
        journal_entry_id: existingJournalEntryId,
      })
      mockCategorizeMatchedTransaction.mockResolvedValueOnce({
        error: 'Transaction already has a journal entry: it was categorized in the meantime.',
        status: 409,
      })

      enqueueMany([
        {
          data: {
            ...pendingOp,
            params: {
              ...pendingOp.params,
              settlement_snapshot: {
                ...settlementSnapshot,
                expectedJournalEntryId: existingJournalEntryId,
              },
            },
          },
        },                                            // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                 // verify approved settlement snapshot
        { data: null, error: null },                  // auto-reject update
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(409)
      // Known-pattern translation of the executor's English message (#337).
      expect(body.error).toBe(
        'Transaktionen är redan bokförd. Ångra kategoriseringen om du vill ändra den.',
      )
    })
  })

  describe('create_customer', () => {
    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'create_customer',
      status: 'pending',
      title: 'Ny kund: Acme AB',
      params: {
        name: 'Acme AB',
        customer_type: 'swedish_business',
        email: 'info@acme.se',
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: { id: 'cust-1', name: 'Acme AB' } }, // insert customer
        { data: null, error: null },                  // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { customer_id: string } }>(response)

      expect(status).toBe(200)
      expect(body.data.customer_id).toBe('cust-1')
    })
  })

  describe('create_invoice', () => {
    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'create_invoice',
      status: 'pending',
      title: 'Ny faktura: Acme AB 15000 SEK',
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttjänster', quantity: 1, unit: 'st', unit_price: 15000 }],
        invoice_date: '2026-03-25',
        due_date: '2026-04-24',
        currency: 'SEK',
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      const customer = {
        id: 'cust-1',
        name: 'Acme AB',
        customer_type: 'swedish_business',
        vat_number_validated: false,
        default_payment_terms: 30,
      }

      enqueueMany([
        { data: pendingOp },                          // fetch pending op
        { data: { id: 'op-1' } },                     // CAS claim
        { data: customer },                           // fetch customer
        { data: { vat_registered: true } },           // company_settings VAT registration gate
        { data: { id: 'inv-1', invoice_number: null } }, // insert invoice (no number: assigned at send)
        { data: null, error: null },                  // insert items
        { data: { id: 'inv-1', invoice_number: null, customer: customer, items: [] } }, // fetch complete invoice
        { data: null, error: null },                  // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { invoice_id: string; invoice_number: string | null } }>(response)

      expect(status).toBe(200)
      expect(body.data.invoice_id).toBe('inv-1')
      // Drafts no longer reserve a number: assigned at send time instead
      expect(body.data.invoice_number).toBeNull()
    })

    it('returns 404 when customer not found', async () => {
      enqueueMany([
        { data: pendingOp },                          // fetch pending op
        { data: { id: 'op-1' } },                     // CAS claim
        { data: null, error: { message: 'not found' } }, // customer not found
        { data: null, error: null },                  // auto-reject update
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(404)
      // English executor message → Swedish HTTP-404 fallback (issue #337).
      expect(body.error).toBe('Resursen kunde inte hittas.')
    })
  })
})
