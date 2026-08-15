import { beforeEach, describe, expect, it, vi } from 'vitest'

interface RecordedWrite {
  table: string
  operation: 'insert' | 'update'
  payload: unknown
}

interface QueryResult {
  data: unknown
  error: null
}

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createJournalEntry: vi.fn(),
  ensureSandboxAgentProfile: vi.fn(),
  failEngineCall: null as number | null,
  getActiveCompanyId: vi.fn(),
  logError: vi.fn(),
  markEntriesNoDocRequired: vi.fn(),
  requireAuth: vi.fn(),
  timeline: [] as string[],
  writes: [] as RecordedWrite[],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: h.requireAuth }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: h.getActiveCompanyId }))
vi.mock('@/lib/auth/rate-limit-http', () => ({ checkRateLimit: h.checkRateLimit }))
vi.mock('@/lib/api/v1/with-api-v1', () => ({ truncateIp: vi.fn(() => '192.0.2.0/24') }))
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({ error: h.logError, warn: vi.fn(), info: vi.fn() })),
}))
vi.mock('@/lib/sandbox/ensure-agent', () => ({
  ensureSandboxAgentProfile: h.ensureSandboxAgentProfile,
}))
vi.mock('@/lib/salary/personnummer', () => ({
  encryptPersonnummer: vi.fn(async () => 'encrypted-personnummer'),
}))
vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: vi.fn(() => ({
    account_name: 'Testkonto',
    account_class: 1,
    account_group: 'Test',
    account_type: 'asset',
    normal_balance: 'debit',
    sru_code: null,
    k2_excluded: false,
  })),
}))
vi.mock('@/lib/bookkeeping/no-doc-required', () => ({
  markEntriesNoDocRequired: h.markEntriesNoDocRequired,
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: h.createJournalEntry,
}))

vi.mock('../customers', () => ({
  buildSandboxCustomers: vi.fn(() => [
    { name: 'Björk & Partner AB' },
    { name: 'Schmidt GmbH' },
    { name: 'Anna Lindström' },
  ]),
}))
vi.mock('../pending-operations', () => ({ buildSandboxPendingOperations: vi.fn(() => []) }))
vi.mock('../articles', () => ({ buildSandboxArticles: vi.fn(() => []) }))
vi.mock('../ledger-history', () => ({
  SANDBOX_LEDGER_ACCOUNT_NUMBERS: ['1930', '3001'],
  buildSandboxLedgerHistory: vi.fn(() => ({
    entries: [
      {
        user_id: 'user-1',
        company_id: 'company-1',
        fiscal_period_id: 'period-1',
        voucher_series: 'A',
        entry_date: '2026-01-31',
        description: 'Historik januari',
        source_type: 'manual',
        source_id: null,
        status: 'posted',
        committed_at: '2026-01-31',
      },
    ],
    linesByEntryIndex: [
      [
        {
          account_number: '1930',
          account_id: 'account-1930',
          debit_amount: 100,
          credit_amount: 0,
          line_description: 'Historik debet',
          sort_order: 0,
          dimensions: { '6': 'P001' },
        },
        {
          account_number: '3001',
          account_id: 'account-3001',
          debit_amount: 0,
          credit_amount: 100,
          line_description: 'Historik kredit',
          sort_order: 1,
          dimensions: {},
        },
      ],
    ],
  })),
}))
vi.mock('../salary', () => ({
  SANDBOX_RUN_TOTALS: {
    total_gross: 100,
    total_tax: 30,
    total_net: 70,
    total_avgifter: 31.42,
    total_vacation_accrual: 12,
  },
  SANDBOX_TOTAL_VACATION_ACCRUAL_AVGIFTER: 3.77,
  buildSandboxEmployees: vi.fn(() => [
    { employee_number: '001' },
    { employee_number: '002' },
  ]),
  mapSandboxEmployeeIds: vi.fn(() => ({
    annaEmployeeId: 'employee-anna',
    erikEmployeeId: 'employee-erik',
  })),
  buildSandboxSalaryRuns: vi.fn(() => [
    { status: 'booked' },
    { status: 'draft' },
  ]),
  buildSandboxSalaryRunEmployees: vi.fn(() => [
    { employee_id: 'employee-anna' },
    { employee_id: 'employee-erik' },
  ]),
  buildSandboxSalaryLineItems: vi.fn(() => []),
  resolveSandboxSalaryPeriods: vi.fn(() => ({
    booked: { paymentDate: '2026-07-25', year: 2026, month: 7 },
  })),
}))
vi.mock('../salary-vouchers', () => ({
  SANDBOX_SALARY_ACCOUNT_NUMBERS: ['1930', '2710', '7210', '7510', '2731', '7290', '2920'],
  buildSandboxSalaryVouchers: vi.fn((input: {
    fiscalPeriodId: string
    salaryRunId: string
    paymentDate: string
  }) => {
    const entry = (description: string) => ({
      user_id: 'user-1',
      company_id: 'company-1',
      fiscal_period_id: input.fiscalPeriodId,
      entry_date: input.paymentDate,
      description,
      source_type: 'salary_payment' as const,
      source_id: input.salaryRunId,
      status: 'posted' as const,
      committed_at: input.paymentDate,
      voucher_series: 'A',
    })
    const lines = (debitAccount: string, creditAccount: string) => [
      {
        account_number: debitAccount,
        debit_amount: 100,
        credit_amount: 0,
        sort_order: 0,
        dimensions: {},
      },
      {
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: 100,
        sort_order: 1,
        dimensions: {},
      },
    ]
    return [
      { runColumn: 'salary_entry_id', entry: entry('Lön 2026-07'), lines: lines('7210', '1930') },
      { runColumn: 'avgifter_entry_id', entry: entry('Arbetsgivaravgifter 2026-07'), lines: lines('7510', '2731') },
      { runColumn: 'vacation_entry_id', entry: entry('Semesterlöneskuld 2026-07'), lines: lines('7290', '2920') },
    ]
  }),
}))

import { POST } from '../route'

function rowsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) return payload ? [payload as Record<string, unknown>] : []
  return payload as Array<Record<string, unknown>>
}

function makeSupabase() {
  const resolveData = (
    table: string,
    operation: 'select' | 'insert' | 'update',
    payload: unknown,
    selectedColumns: string | undefined,
    inValues: unknown[] | undefined,
  ): unknown => {
    if (table === 'company_settings' && operation === 'select') return null
    if (table === 'dimensions') {
      return [
        { id: 'dimension-1', sie_dim_no: 1 },
        { id: 'dimension-6', sie_dim_no: 6 },
      ]
    }
    if (table === 'fiscal_periods') return { id: 'period-1' }
    if (table === 'chart_of_accounts' && selectedColumns === 'account_number') {
      return (inValues ?? []).map(account_number => ({ account_number }))
    }
    if (table === 'chart_of_accounts' && selectedColumns === 'id, account_number') {
      return (inValues ?? []).map(account_number => ({
        id: `account-${String(account_number)}`,
        account_number,
      }))
    }

    const rows = rowsFromPayload(payload)
    if (table === 'customers') return rows.map((row, index) => ({ ...row, id: `customer-${index + 1}` }))
    if (table === 'invoices') return rows.map((row, index) => ({ ...row, id: `invoice-${index + 1}` }))
    if (table === 'transactions') return rows.map((row, index) => ({ ...row, id: `transaction-${index + 1}` }))
    if (table === 'suppliers') return rows.map((row, index) => ({ ...row, id: `supplier-${index + 1}` }))
    if (table === 'supplier_invoices') {
      return rows.map((row, index) => ({ ...row, id: `supplier-invoice-${index + 1}` }))
    }
    if (table === 'invoice_inbox_items') return { ...rows[0], id: 'inbox-1' }
    if (table === 'employees') {
      return [
        { id: 'employee-anna', employee_number: '001' },
        { id: 'employee-erik', employee_number: '002' },
      ]
    }
    if (table === 'salary_runs' && operation === 'insert') {
      return [
        { id: 'run-booked', status: 'booked' },
        { id: 'run-draft', status: 'draft' },
      ]
    }
    if (table === 'salary_run_employees') {
      return [
        { id: 'run-employee-anna', employee_id: 'employee-anna' },
        { id: 'run-employee-erik', employee_id: 'employee-erik' },
      ]
    }
    return null
  }

  const from = vi.fn((table: string) => {
    let operation: 'select' | 'insert' | 'update' = 'select'
    let payload: unknown
    let selectedColumns: string | undefined
    let inValues: unknown[] | undefined
    let executed = false

    const execute = (): QueryResult => {
      if (!executed && operation !== 'select') {
        executed = true
        h.writes.push({ table, operation, payload })
        h.timeline.push(`write:${table}:${operation}`)
      }
      return {
        data: resolveData(table, operation, payload, selectedColumns, inValues),
        error: null,
      }
    }

    const query: Record<string, unknown> = {}
    query.select = (columns: string) => {
      selectedColumns = columns
      return query
    }
    query.insert = (value: unknown) => {
      operation = 'insert'
      payload = value
      return query
    }
    query.update = (value: unknown) => {
      operation = 'update'
      payload = value
      return query
    }
    for (const method of ['eq', 'order', 'range', 'limit', 'gte', 'lte']) {
      query[method] = () => query
    }
    query.in = (_column: string, values: unknown[]) => {
      inValues = values
      return query
    }
    query.single = async () => execute()
    query.maybeSingle = async () => execute()
    query.then = (
      onFulfilled: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(execute()).then(onFulfilled, onRejected)
    return query
  })

  return {
    from,
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }
}

function seedRequest(): Request {
  return new Request('http://localhost/api/sandbox/seed', {
    method: 'POST',
    headers: { 'x-forwarded-for': '192.0.2.10' },
  })
}

function findWrite(table: string, operation: 'insert' | 'update'): RecordedWrite | undefined {
  return h.writes.find(write => write.table === table && write.operation === operation)
}

describe('POST /api/sandbox/seed journal boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.failEngineCall = null
    h.timeline.length = 0
    h.writes.length = 0

    const supabase = makeSupabase()
    h.checkRateLimit.mockResolvedValue({ ok: true })
    h.getActiveCompanyId.mockResolvedValue('company-1')
    h.requireAuth.mockResolvedValue({
      user: { id: 'user-1', is_anonymous: true },
      supabase,
    })
    h.ensureSandboxAgentProfile.mockResolvedValue(undefined)
    h.markEntriesNoDocRequired.mockImplementation(async () => {
      h.timeline.push('write:history-no-doc-required')
    })
    h.createJournalEntry.mockImplementation(async (
      _supabase: unknown,
      _companyId: string,
      _userId: string,
      input: { source_type: string; description: string },
    ) => {
      const callNumber = h.createJournalEntry.mock.calls.length
      h.timeline.push(`engine:${input.source_type}:${input.description}`)
      if (h.failEngineCall === callNumber) throw new Error(`engine failure ${callNumber}`)
      return { id: `entry-${callNumber}` }
    })
  })

  it('creates history, invoice, and salary journals through the engine before link writes', async () => {
    const response = await POST(seedRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ seeded: true })
    expect(h.createJournalEntry).toHaveBeenCalledTimes(6)

    const inputs = h.createJournalEntry.mock.calls.map(call => call[3])
    expect(inputs[0]).toEqual({
      fiscal_period_id: 'period-1',
      entry_date: '2026-01-31',
      description: 'Historik januari',
      source_type: 'manual',
      source_id: undefined,
      voucher_series: 'A',
      lines: [
        {
          account_number: '1930',
          debit_amount: 100,
          credit_amount: 0,
          line_description: 'Historik debet',
          dimensions: { '6': 'P001' },
        },
        {
          account_number: '3001',
          debit_amount: 0,
          credit_amount: 100,
          line_description: 'Historik kredit',
          dimensions: {},
        },
      ],
    })
    expect(inputs[1]).toEqual(expect.objectContaining({
      source_type: 'invoice_created',
      source_id: 'invoice-1',
      voucher_series: 'A',
      description: 'Faktura F-2026001, Björk & Partner AB',
      lines: [
        expect.objectContaining({ account_number: '1510', debit_amount: 18750 }),
        expect.objectContaining({ account_number: '3001', credit_amount: 15000, dimensions: { '1': 'BUTIK', '6': 'P001' } }),
        expect.objectContaining({ account_number: '2611', credit_amount: 3750 }),
      ],
    }))
    expect(inputs[2]).toEqual(expect.objectContaining({
      source_type: 'invoice_paid',
      source_id: 'invoice-1',
      voucher_series: 'A',
      description: 'Betalning faktura F-2026001, Björk & Partner AB',
      lines: [
        expect.objectContaining({ account_number: '1930', debit_amount: 18750 }),
        expect.objectContaining({ account_number: '1510', credit_amount: 18750 }),
      ],
    }))
    expect(inputs.slice(3)).toEqual([
      expect.objectContaining({ source_type: 'salary_payment', source_id: 'run-booked', description: 'Lön 2026-07' }),
      expect.objectContaining({ source_type: 'salary_payment', source_id: 'run-booked', description: 'Arbetsgivaravgifter 2026-07' }),
      expect.objectContaining({ source_type: 'salary_payment', source_id: 'run-booked', description: 'Semesterlöneskuld 2026-07' }),
    ])
    for (const call of h.createJournalEntry.mock.calls) {
      expect(call[4]).toBe('sandbox_seed')
    }

    expect(h.timeline.indexOf('engine:manual:Historik januari')).toBeLessThan(
      h.timeline.indexOf('write:history-no-doc-required'),
    )
    expect(h.timeline.indexOf('engine:invoice_paid:Betalning faktura F-2026001, Björk & Partner AB')).toBeLessThan(
      h.timeline.indexOf('write:transactions:insert'),
    )
    expect(h.timeline.indexOf('engine:salary_payment:Semesterlöneskuld 2026-07')).toBeLessThan(
      h.timeline.indexOf('write:salary_runs:update'),
    )

    const transactionWrite = findWrite('transactions', 'insert')
    expect(rowsFromPayload(transactionWrite?.payload)).toContainEqual(
      expect.objectContaining({ invoice_id: 'invoice-1', journal_entry_id: 'entry-3' }),
    )
    expect(findWrite('salary_runs', 'update')?.payload).toEqual({
      salary_entry_id: 'entry-4',
      avgifter_entry_id: 'entry-5',
      vacation_entry_id: 'entry-6',
    })
  })

  it('does not mark history entries when the history engine call fails', async () => {
    h.failEngineCall = 1

    const response = await POST(seedRequest())

    expect(response.status).toBe(500)
    expect(h.markEntriesNoDocRequired).not.toHaveBeenCalled()
    expect(findWrite('transactions', 'insert')).toBeUndefined()
    expect(findWrite('salary_runs', 'update')).toBeUndefined()
  })

  it('does not persist the invoice transaction link when invoice posting fails', async () => {
    h.failEngineCall = 3

    const response = await POST(seedRequest())

    expect(response.status).toBe(500)
    expect(h.markEntriesNoDocRequired).toHaveBeenCalledOnce()
    expect(findWrite('transactions', 'insert')).toBeUndefined()
    expect(findWrite('salary_runs', 'update')).toBeUndefined()
  })

  it('does not persist salary links until every salary engine call succeeds', async () => {
    h.failEngineCall = 5

    const response = await POST(seedRequest())

    expect(response.status).toBe(500)
    expect(findWrite('transactions', 'insert')).toBeDefined()
    expect(findWrite('salary_runs', 'update')).toBeUndefined()
    expect(h.createJournalEntry).toHaveBeenCalledTimes(5)
  })
})
