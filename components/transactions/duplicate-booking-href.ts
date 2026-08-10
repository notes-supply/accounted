const JOURNAL_ENTRY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Build a same-origin voucher path from an untrusted imported journal id. */
export function duplicateBookingVoucherHref(journalEntryId: string): string {
  if (!JOURNAL_ENTRY_UUID_PATTERN.test(journalEntryId)) return '/bookkeeping'

  return `/bookkeeping/${journalEntryId}`
}
