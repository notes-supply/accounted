/**
 * Reverse-charge basis accounts grouped by VAT rate across the five purchase
 * families: EU goods, EU services, non-EU services, domestic goods RC, and
 * domestic services RC.
 *
 * This is the single source for both the filing gate's per-rate downgrade
 * evidence and the per-voucher gap scan. It lives in a dependency-free module
 * because the gate already imports the scanner.
 */
export const RC_BASIS_ACCOUNTS_BY_RATE = {
  r25: ['4515', '4535', '4531', '4415', '4425'],
  r12: ['4516', '4536', '4532', '4416', '4426'],
  r6: ['4517', '4537', '4533', '4417', '4427'],
} as const
