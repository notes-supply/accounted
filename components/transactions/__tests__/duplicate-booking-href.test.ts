import { describe, expect, it } from 'vitest'
import { duplicateBookingVoucherHref } from '../duplicate-booking-href'

describe('duplicateBookingVoucherHref', () => {
  const origin = 'https://app.accounted.se'

  it('keeps a canonical UUID under the bookkeeping path', () => {
    const journalEntryId = 'A0b1C2d3-E4f5-6789-aBcD-0123456789Ef'
    const href = duplicateBookingVoucherHref(journalEntryId)
    const resolved = new URL(href, origin)

    expect(href).toBe(`/bookkeeping/${journalEntryId}`)
    expect(resolved.origin).toBe(origin)
    expect(resolved.pathname).toBe(`/bookkeeping/${journalEntryId}`)
    expect(resolved.search).toBe('')
    expect(resolved.hash).toBe('')
  })

  it.each([
    '.',
    '..',
    '%2e',
    '%2e%2e',
    '../../settings',
    '..\\..\\settings',
    '\\settings',
    '\\\\host',
    '..%5c..%5csettings',
    '?',
    '#',
    '//host',
    '',
    'not-a-uuid',
    'a0b1c2d3-e4f5-6789-abcd-0123456789e',
    'a0b1c2d3-e4f5-6789-abcd-0123456789eg',
  ])('falls back to the bookkeeping root for invalid input %j', (journalEntryId) => {
    const href = duplicateBookingVoucherHref(journalEntryId)
    const resolved = new URL(href, origin)

    expect(href).toBe('/bookkeeping')
    expect(resolved.origin).toBe(origin)
    expect(resolved.pathname).toBe('/bookkeeping')
    expect(resolved.search).toBe('')
    expect(resolved.hash).toBe('')
  })
})
