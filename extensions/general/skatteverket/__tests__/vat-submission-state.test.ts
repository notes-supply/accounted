import { describe, expect, it } from 'vitest'
import type { VatDeclarationRutor } from '@/types'
import {
  VatSubmissionConflictError,
  assertSameVatSubmissionIdentity,
  canonicalVatRutor,
  createVatSubmissionState,
  parseVatSubmissionState,
  transitionVatSubmissionState,
  type VatSubmissionIdentity,
} from '../lib/vat-submission-state'

const RUTA_KEYS = [
  'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
  'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31',
  'ruta32', 'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40',
  'ruta41', 'ruta42', 'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61',
  'ruta62',
] as const

function zeroRutor(): VatDeclarationRutor {
  return Object.fromEntries(
    RUTA_KEYS.map((key) => [key, 0]),
  ) as unknown as VatDeclarationRutor
}

function identity(): VatSubmissionIdentity {
  return {
    redovisare: '165560000000',
    redovisningsperiod: '202606',
    periodType: 'yearly',
    year: 2026,
    period: 1,
    resolvedPeriodStart: '2025-07-15',
    resolvedPeriodEnd: '2026-06-30',
    originalPeriodStart: '2025-07-01',
    originalPeriodEnd: '2026-06-30',
    fiscalPeriodId: '11111111-1111-4111-8111-111111111111',
    fiscalPeriodStart: '2025-07-01',
    fiscalPeriodEnd: '2026-06-30',
    vatLiabilityStartDate: '2025-07-15',
    approvedRutor: zeroRutor(),
    approvedMomsuppgift: { summaMoms: 0 },
  }
}

describe('VAT submission identity state', () => {
  it('rejects a legacy state without immutable bounds and approved rutor', () => {
    expect(() => parseVatSubmissionState({
      status: 'draft_locked',
      redovisare: '165560000000',
      redovisningsperiod: '202606',
      periodType: 'yearly',
      year: 2026,
      period: 1,
      updatedAt: new Date().toISOString(),
    })).toThrow(/immutable identity|invalid/)
  })

  it('preserves every identity field while status advances', () => {
    const draft = createVatSubmissionState(identity(), 'draft_saved')
    const locked = transitionVatSubmissionState(draft, 'draft_locked', {
      signeringsLank: 'https://example.test/sign',
    })
    expect(parseVatSubmissionState(locked)).toMatchObject({
      ...identity(),
      status: 'draft_locked',
      signeringsLank: 'https://example.test/sign',
    })
  })

  it('rejects runtime attempts to replace immutable identity during transition', () => {
    const draft = createVatSubmissionState(identity(), 'draft_saved')
    expect(() => transitionVatSubmissionState(
      draft,
      'draft_locked',
      { redovisare: '165560000001' } as never,
    )).toThrow(VatSubmissionConflictError)
  })

  it('rejects backward or skipped state changes that are not remote progress', () => {
    const decided = createVatSubmissionState(identity(), 'decided')
    expect(() => transitionVatSubmissionState(decided, 'draft_saved'))
      .toThrow(VatSubmissionConflictError)
  })

  it('detects liability, taxpayer, bounds or ruta drift', () => {
    expect(() => assertSameVatSubmissionIdentity(
      identity(),
      { ...identity(), vatLiabilityStartDate: null },
    )).toThrow(VatSubmissionConflictError)
    const changedRutor = zeroRutor()
    changedRutor.ruta48 = 1
    expect(() => assertSameVatSubmissionIdentity(
      identity(),
      { ...identity(), approvedRutor: changedRutor },
    )).toThrow(VatSubmissionConflictError)
  })

  it('requires every approved ruta to be finite and rejects extra keys', () => {
    const invalid = { ...zeroRutor(), ruta48: '100' }
    expect(() => canonicalVatRutor(invalid)).toThrow(/ruta48/)
    expect(() => canonicalVatRutor({ ...zeroRutor(), extra: 1 }))
      .toThrow(/invalid shape/)
  })

  it('rejects non-canonical period, timestamp, bounds, and payload state', () => {
    const valid = createVatSubmissionState(identity(), 'draft_saved')
    expect(() => parseVatSubmissionState({ ...valid, year: 1999 }))
      .toThrow(/immutable identity/)
    expect(() => parseVatSubmissionState({
      ...valid,
      updatedAt: valid.updatedAt.replace('Z', '+00:00'),
    })).toThrow(/immutable identity/)
    expect(() => parseVatSubmissionState({
      ...valid,
      resolvedPeriodStart: '2025-08-01',
    })).toThrow(/inconsistent bounds/)
    expect(() => parseVatSubmissionState({
      ...valid,
      approvedMomsuppgift: { summaMoms: 1 },
    })).toThrow(/inconsistent approved payload/)
    expect(() => parseVatSubmissionState({
      ...valid,
      approvedMomsuppgift: { summaMoms: 0, unexpected: 1 },
    })).toThrow(/invalid unexpected/)
  })

  it('rejects unknown persisted state fields', () => {
    expect(() => parseVatSubmissionState({
      ...createVatSubmissionState(identity(), 'draft_saved'),
      unexpected: true,
    })).toThrow(/unknown fields/)
  })
})
