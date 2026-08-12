export const DEFAULT_RECEIPT_HUNT_MIN_CONFIDENCE = 0.7
export const DEFAULT_RECEIPT_HUNT_MAX_RECEIPTS = 25
export const DEFAULT_RECEIPT_HUNT_MAX_MAILS = 40

/** Hard cost and storage ceilings for one company hunt across all mailboxes. */
export const MAX_CONFIGURED_RECEIPTS = 100
export const MAX_CONFIGURED_MAILS = 100
export const MAX_ALLOWLIST_COMPANIES = 25

function parseBoundedPositiveSafeInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const normalized = raw?.trim()
  if (!normalized) return fallback
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return parsed
}

export function getReceiptHuntMaxReceipts(
  raw: string | undefined = process.env.RECEIPT_HUNT_MAX_RECEIPTS,
): number {
  return parseBoundedPositiveSafeInteger(
    'RECEIPT_HUNT_MAX_RECEIPTS',
    raw,
    DEFAULT_RECEIPT_HUNT_MAX_RECEIPTS,
    MAX_CONFIGURED_RECEIPTS,
  )
}

export function getReceiptHuntMaxMails(
  raw: string | undefined = process.env.RECEIPT_HUNT_MAX_MAILS,
): number {
  return parseBoundedPositiveSafeInteger(
    'RECEIPT_HUNT_MAX_MAILS',
    raw,
    DEFAULT_RECEIPT_HUNT_MAX_MAILS,
    MAX_CONFIGURED_MAILS,
  )
}

export function parseCompanyAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
  if (ids.length > MAX_ALLOWLIST_COMPANIES) {
    throw new Error(
      `RECEIPT_HUNT_COMPANY_IDS may contain at most ${MAX_ALLOWLIST_COMPANIES} companies`,
    )
  }
  return ids
}

/**
 * Minimum score for staging a receipt-hunt proposal.
 *
 * Invalid configuration throws so production cannot silently run at an
 * unintended confidence threshold.
 */
export function getReceiptHuntMinConfidence(
  raw: string | undefined = process.env.RECEIPT_HUNT_MIN_CONFIDENCE,
): number {
  const normalized = raw?.trim()
  if (!normalized) return DEFAULT_RECEIPT_HUNT_MIN_CONFIDENCE
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    throw new Error('RECEIPT_HUNT_MIN_CONFIDENCE must be a finite number in (0, 1]')
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error('RECEIPT_HUNT_MIN_CONFIDENCE must be a finite number in (0, 1]')
  }
  return parsed
}
