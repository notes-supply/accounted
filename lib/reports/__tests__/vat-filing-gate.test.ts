import { describe, it, expect } from 'vitest'
import {
  isFilingBlocked,
  rcBasisGapFinding,
  rcBasisScanUnavailableFinding,
  withRcBasisGapFindings,
} from '../vat-filing-gate'
import type { VatDeclarationCheck } from '../vat-declaration-checks'

const aggregateRcBasisMissing: VatDeclarationCheck = {
  code: 'RC_BASIS_MISSING',
  status: 'ERROR',
  message: 'aggregate finding',
}

const warningOnly: VatDeclarationCheck = {
  code: 'RC_INPUT_VAT_MISMATCH',
  status: 'WARNING',
  message: 'warning finding',
}

describe('withRcBasisGapFindings', () => {
  it('leaves the list untouched when the scan found no gaps', () => {
    expect(withRcBasisGapFindings([], { status: 'scanned', gapCount: 0 })).toEqual([])
    expect(
      withRcBasisGapFindings([warningOnly], { status: 'scanned', gapCount: 0 }),
    ).toEqual([warningOnly])
  })

  it('says nothing while the scan is still in flight', () => {
    // Pending is not "inga brister", but it is not worth a row either: the
    // scan resolves in the same breath as the declaration itself.
    expect(withRcBasisGapFindings([], { status: 'pending' })).toEqual([])
  })

  it('adds a blocking finding when the aggregate check stayed silent', () => {
    // The filing hole: a 0.5% tolerance on a large period absorbs the whole
    // shortfall, so runVatDeclarationChecks returns [] while individual
    // verifikat still miss their basbelopp.
    const result = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 })
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('RC_BASIS_MISSING')
    expect(result[0].status).toBe('ERROR')
    expect(result[0].message).toContain('2 verifikationer')
  })

  it('keeps warnings and appends the gap finding after them', () => {
    const result = withRcBasisGapFindings([warningOnly], { status: 'scanned', gapCount: 1 })
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(warningOnly)
    expect(result[1].message).toContain('1 verifikation ')
  })

  it('does not duplicate the message when the aggregate check already fired', () => {
    const result = withRcBasisGapFindings([aggregateRcBasisMissing], {
      status: 'scanned',
      gapCount: 3,
    })
    expect(result).toEqual([aggregateRcBasisMissing])
  })

  it('does not mutate the input array', () => {
    const input: VatDeclarationCheck[] = [warningOnly]
    withRcBasisGapFindings(input, { status: 'scanned', gapCount: 4 })
    expect(input).toHaveLength(1)
  })
})

describe('withRcBasisGapFindings, failed scan', () => {
  it('adds a blocking finding because required filing evidence is unavailable', () => {
    // An empty check list renders as "Inga fel hittades i underlaget för
    // perioden". A scan that never answered has not earned that sentence.
    const result = withRcBasisGapFindings([], { status: 'unavailable' })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('ERROR')
    expect(isFilingBlocked(result)).toBe(true)
  })

  it('does not stack on top of a finding that already blocks', () => {
    const result = withRcBasisGapFindings([aggregateRcBasisMissing], { status: 'unavailable' })
    expect(result).toEqual([aggregateRcBasisMissing])
  })
})

describe('isFilingBlocked', () => {
  it('is false for an empty list and for warnings only', () => {
    expect(isFilingBlocked([])).toBe(false)
    expect(isFilingBlocked([warningOnly])).toBe(false)
  })

  it('is true for any ERROR', () => {
    expect(isFilingBlocked([warningOnly, aggregateRcBasisMissing])).toBe(true)
  })

  it('is true for a declaration whose only fault is unfixed gap verifikat', () => {
    // The regression this whole module exists for: banner and Skicka button
    // read the SAME folded array, so "inga fel" can no longer render above a
    // populated worklist with the send button enabled.
    const checks = withRcBasisGapFindings([], { status: 'scanned', gapCount: 2 })
    expect(checks.length).toBeGreaterThan(0)
    expect(isFilingBlocked(checks)).toBe(true)
  })
})

describe('rcBasisGapFinding', () => {
  it('names the boxes and the SKV rejection code so the user can act', () => {
    const finding = rcBasisGapFinding(1)
    expect(finding.message).toContain('ruta 20-24')
    expect(finding.message).toContain('FK004')
    expect(finding.rutor).toContain('ruta20')
  })

  it('uses singular and plural Swedish wording', () => {
    expect(rcBasisGapFinding(1).message).toContain('1 verifikation i perioden')
    expect(rcBasisGapFinding(5).message).toContain('5 verifikationer i perioden')
    expect(rcBasisGapFinding(1).message).toContain('Korrigera verifikationen')
    expect(rcBasisGapFinding(5).message).toContain('Korrigera verifikationerna')
  })
})

describe('rcBasisScanUnavailableFinding', () => {
  it('is a stable error that admits it does not know, and points at the worklist', () => {
    const finding = rcBasisScanUnavailableFinding()
    expect(finding.code).toBe('RC_BASIS_SCAN_UNAVAILABLE')
    expect(finding.status).toBe('ERROR')
    expect(finding.message).toContain('kunde inte köras')
    expect(finding.message).toContain('listan nedan')
  })
})
