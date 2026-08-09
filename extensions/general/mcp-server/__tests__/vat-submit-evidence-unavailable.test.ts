import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { VatDeclarationRutor } from '@/types'

const mockFindRcBasisGaps = vi.fn()
vi.mock('@/lib/reports/rc-basis-gaps', () => ({
  findRcBasisGaps: (...args: unknown[]) => mockFindRcBasisGaps(...args),
}))

const rutor: VatDeclarationRutor = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
  ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
  ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0,
  ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0,
  ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

const mockCalculateVatDeclaration = vi.fn(async () => ({ rutor }))
vi.mock('@/lib/reports/vat-declaration', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    calculateVatDeclaration: (...args: unknown[]) => mockCalculateVatDeclaration(...args),
  }
})

const mockBuildMomsuppgift = vi.fn(async () => ({
  redovisare: '165560000000',
  redovisningsperiod: '202601',
  momsuppgift: { summaMoms: 0 },
  declaration: await mockCalculateVatDeclaration(),
  resolvedPeriodStart: '2026-01-01',
  resolvedPeriodEnd: '2026-01-31',
}))
vi.mock('@/extensions/general/skatteverket/lib/declaration-prep', () => ({
  buildMomsuppgift: (...args: unknown[]) => mockBuildMomsuppgift(...args),
  resolveRedovisare: vi.fn(),
}))

const mockSkvRequest = vi.fn()
vi.mock('@/extensions/general/skatteverket/lib/api-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, skvRequest: (...args: unknown[]) => mockSkvRequest(...args) }
})

vi.mock('@/extensions/general/skatteverket/lib/audit', () => ({
  writeSkatteverketAudit: vi.fn(),
}))

import { tools } from '../server'

const submit = tools.find((tool) => tool.name === 'gnubok_vat_declaration_submit')!

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SKATTEVERKET_ENABLED = 'true'
})

describe('gnubok_vat_declaration_submit: unavailable required evidence', () => {
  it('fails before Skatteverket validation and before staging', async () => {
    mockFindRcBasisGaps.mockRejectedValue(new Error('evidence query failed'))
    const insert = vi.fn()
    const supabase = {
      from: vi.fn(() => ({ insert })),
    } as never

    await expect(submit.execute(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      'user-1',
      supabase,
      { type: 'api_key' },
    )).rejects.toThrow(/RC_BASIS_SCAN_UNAVAILABLE/)

    expect(mockBuildMomsuppgift).toHaveBeenCalledOnce()
    expect(mockSkvRequest).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })
})
