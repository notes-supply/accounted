import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_ALLOWLIST_COMPANIES,
  MAX_CONFIGURED_MAILS,
  MAX_CONFIGURED_RECEIPTS,
  getReceiptHuntMaxMails,
  getReceiptHuntMaxReceipts,
  getReceiptHuntMinConfidence,
  parseCompanyAllowlist,
} from '../config'

const ORIGINAL = process.env.RECEIPT_HUNT_MIN_CONFIDENCE

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RECEIPT_HUNT_MIN_CONFIDENCE
  else process.env.RECEIPT_HUNT_MIN_CONFIDENCE = ORIGINAL
})

describe('bounded receipt-hunt integer configuration', () => {
  it.each([
    ['receipts', getReceiptHuntMaxReceipts, 25, MAX_CONFIGURED_RECEIPTS],
    ['mails', getReceiptHuntMaxMails, 40, MAX_CONFIGURED_MAILS],
  ] as const)('uses a bounded default and accepts the hard maximum for %s', (_label, parse, fallback, max) => {
    expect(parse(undefined)).toBe(fallback)
    expect(parse('  ')).toBe(fallback)
    expect(parse(String(max))).toBe(max)
  })

  it.each(['0', '-1', '1.5', '1e2', 'NaN', 'Infinity', ' 2x ', '9007199254740992'])
    ('rejects unsafe or malformed integer %s', (raw) => {
      expect(() => getReceiptHuntMaxReceipts(raw)).toThrow(/RECEIPT_HUNT_MAX_RECEIPTS/)
      expect(() => getReceiptHuntMaxMails(raw)).toThrow(/RECEIPT_HUNT_MAX_MAILS/)
    })

  it('rejects values above each documented hard maximum', () => {
    expect(() => getReceiptHuntMaxReceipts(String(MAX_CONFIGURED_RECEIPTS + 1))).toThrow()
    expect(() => getReceiptHuntMaxMails(String(MAX_CONFIGURED_MAILS + 1))).toThrow()
  })

  it('bounds, trims, and de-duplicates the company allowlist', () => {
    expect(parseCompanyAllowlist(' co-1,co-1, co-2 ')).toEqual(['co-1', 'co-2'])
    const tooMany = Array.from({ length: MAX_ALLOWLIST_COMPANIES + 1 }, (_, i) => `co-${i}`).join(',')
    expect(() => parseCompanyAllowlist(tooMany)).toThrow(/RECEIPT_HUNT_COMPANY_IDS/)
  })
})

describe('RECEIPT_HUNT_MIN_CONFIDENCE', () => {
  it('defaults to 0.7 when unset or blank', () => {
    delete process.env.RECEIPT_HUNT_MIN_CONFIDENCE
    expect(getReceiptHuntMinConfidence()).toBe(0.7)
    process.env.RECEIPT_HUNT_MIN_CONFIDENCE = '  '
    expect(getReceiptHuntMinConfidence()).toBe(0.7)
  })

  it.each([
    ['smallest valid positive value', '0.0001', 0.0001],
    ['default boundary', '0.7', 0.7],
    ['upper boundary', '1', 1],
  ])('accepts %s', (_label, raw, expected) => {
    process.env.RECEIPT_HUNT_MIN_CONFIDENCE = raw
    expect(getReceiptHuntMinConfidence()).toBe(expected)
  })

  it.each(['0', '-0.1', '1.0001', 'NaN', 'Infinity', '0.7oops'])(
    'fails closed on malformed or out-of-range value %s',
    (raw) => {
      process.env.RECEIPT_HUNT_MIN_CONFIDENCE = raw
      expect(() => getReceiptHuntMinConfidence()).toThrow(/RECEIPT_HUNT_MIN_CONFIDENCE/)
    },
  )
})
