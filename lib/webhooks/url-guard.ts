/**
 * Webhook URL safety guard.
 *
 * SSRF mitigation for the dispatcher: a webhook receiver URL is supplied by
 * the caller, and the dispatcher POSTs HMAC-signed payloads to it from the
 * Vercel function's network position. Without validation, a malicious
 * caller could direct the dispatcher at internal addresses (cloud metadata
 * endpoints at 169.254.169.254, kube-internal services at 10.x, loopback,
 * etc.) and exfiltrate signed payloads or probe internal infrastructure.
 *
 * Two-layer defense:
 *   1. At create / update time the v1 routes call `assertSafeWebhookUrl`
 *      and reject the request with VALIDATION_ERROR if the URL fails.
 *   2. At dispatch time the dispatcher calls the same helper before each
 *      HTTP request: DNS records can change between creation and
 *      dispatch (rebind attacks, DNS hijack), so the create-time check
 *      alone is insufficient.
 *
 * Errors carry a stable `reason` string so the route can surface a
 * structured details object and the dispatcher can stamp it on the
 * delivery's error column.
 */

import { promises as dns } from 'node:dns'
import { BlockList, isIP } from 'node:net'

export type WebhookUrlValidationReason =
  | 'invalid_url'
  | 'non_https_scheme'
  | 'dns_lookup_failed'
  | 'no_dns_records'
  | 'private_address'
  | 'loopback_address'
  | 'link_local_address'
  | 'cgnat_address'
  | 'metadata_address'
  | 'unspecified_address'
  | 'unsafe_address'

export interface WebhookUrlValidationError {
  ok: false
  reason: WebhookUrlValidationReason
  detail: string
}

export interface WebhookUrlValidationOk {
  ok: true
  hostname: string
  /** All A/AAAA records resolved at validation time. Every entry is publicly routable. */
  resolvedAddresses: string[]
}

export type WebhookUrlValidationResult = WebhookUrlValidationOk | WebhookUrlValidationError

/**
 * Validate that the URL is HTTPS and that EVERY A/AAAA record for the
 * hostname resolves to a publicly-routable address. Returns a
 * discriminated result rather than throwing so call sites can surface a
 * clean validation error envelope.
 *
 * Multi-record enumeration (vs single dns.lookup) closes a round-robin
 * DNS bypass: a hostname with two A records [public, private] returns
 * either non-deterministically per call. Single-lookup validation could
 * return the public IP at create time and the private IP at dispatch
 * time. Resolving ALL records and rejecting if ANY is unsafe forecloses
 * that path. Callers that connect through pinnedHttpsFetch also close the
 * validation-to-connection rebinding window by pinning one vetted address.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  opts?: { resolve4?: typeof dns.resolve4; resolve6?: typeof dns.resolve6 },
): Promise<WebhookUrlValidationResult> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url', detail: 'URL did not parse.' }
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'non_https_scheme',
      detail: `webhook_url must use https:// (got ${parsed.protocol}).`,
    }
  }

  const literal = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  if (isIP(literal)) {
    const classification = classifyAddress(literal)
    if (classification !== 'public') {
      return {
        ok: false,
        reason: classification,
        detail: `Address ${literal} is not publicly routable (${classification}).`,
      }
    }
    return { ok: true, hostname: parsed.hostname, resolvedAddresses: [literal] }
  }

  const resolve4 = opts?.resolve4 ?? dns.resolve4
  const resolve6 = opts?.resolve6 ?? dns.resolve6

  // Resolve A and AAAA in parallel. Each returns an array of address
  // strings or throws ENODATA / ENOTFOUND when there are no records of
  // that family. Treat a per-family ENODATA as "no records" rather than
  // a hard failure: the other family may still resolve.
  const [v4Result, v6Result] = await Promise.allSettled([
    resolve4(parsed.hostname),
    resolve6(parsed.hostname),
  ])

  const addresses: string[] = []
  let hardFailure: Error | null = null
  for (const r of [v4Result, v6Result]) {
    if (r.status === 'fulfilled') {
      addresses.push(...r.value)
    } else {
      const code = (r.reason as { code?: string } | null)?.code
      // ENODATA / ENOTFOUND for one family is normal (e.g. v6-only or
      // v4-only host). Other errors (server failure, timeout) propagate.
      if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
        hardFailure = r.reason instanceof Error ? r.reason : new Error(String(r.reason))
      }
    }
  }

  if (hardFailure) {
    return {
      ok: false,
      reason: 'dns_lookup_failed',
      detail: `DNS lookup failed for ${parsed.hostname}: ${hardFailure.message}`,
    }
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: 'no_dns_records',
      detail: `No A/AAAA records for ${parsed.hostname}.`,
    }
  }

  for (const address of addresses) {
    const classification = classifyAddress(address)
    if (classification !== 'public') {
      return {
        ok: false,
        reason: classification,
        detail: `Resolved address ${address} for ${parsed.hostname} is not publicly routable (${classification}).`,
      }
    }
  }

  return { ok: true, hostname: parsed.hostname, resolvedAddresses: addresses }
}

type AddressClass =
  | 'public'
  | 'loopback_address'
  | 'private_address'
  | 'link_local_address'
  | 'cgnat_address'
  | 'metadata_address'
  | 'unspecified_address'
  | 'unsafe_address'

const PRIVATE_V4 = new BlockList()
PRIVATE_V4.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE_V4.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE_V4.addSubnet('192.168.0.0', 16, 'ipv4')

const UNSAFE_V4 = new BlockList()
UNSAFE_V4.addSubnet('192.0.0.0', 24, 'ipv4')
UNSAFE_V4.addSubnet('192.0.2.0', 24, 'ipv4')
UNSAFE_V4.addSubnet('192.88.99.0', 24, 'ipv4')
UNSAFE_V4.addSubnet('198.18.0.0', 15, 'ipv4')
UNSAFE_V4.addSubnet('198.51.100.0', 24, 'ipv4')
UNSAFE_V4.addSubnet('203.0.113.0', 24, 'ipv4')
UNSAFE_V4.addSubnet('224.0.0.0', 4, 'ipv4')
UNSAFE_V4.addSubnet('240.0.0.0', 4, 'ipv4')

// IPv6 is fail-closed: only the IANA global-unicast allocation 2000::/3 is
// eligible, then special-purpose subranges inside it are excluded. This is an
// explicit allow policy, not an open-ended denylist. It therefore rejects
// newly introduced protocol/special ranges outside 2000::/3 until reviewed.
//
// Sources: IANA IPv6 Special-Purpose Address Registry and RFC 4291 section 2.4.
// We conservatively reject the whole 2001::/23 IETF protocol-assignment block,
// including Teredo, benchmarking, ORCHID, AMT, AS112, and related anycast
// assignments, even where a narrower entry may carry a globally-reachable
// flag. Webhook destinations have no reason to depend on those protocols.
const GLOBAL_UNICAST_V6 = new BlockList()
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6')

const NON_GLOBAL_UNICAST_V6 = new BlockList()
NON_GLOBAL_UNICAST_V6.addSubnet('2001::', 23, 'ipv6')
NON_GLOBAL_UNICAST_V6.addSubnet('2001:db8::', 32, 'ipv6')
NON_GLOBAL_UNICAST_V6.addSubnet('2002::', 16, 'ipv6')
NON_GLOBAL_UNICAST_V6.addSubnet('2620:4f:8000::', 48, 'ipv6')
NON_GLOBAL_UNICAST_V6.addSubnet('3fff::', 20, 'ipv6')

/**
 * Map an IPv4 or IPv6 address string to a safety class. IPv4 preserves its
 * complete explicit classification. IPv6 returns public only for ordinary
 * global unicast after the special-purpose exclusions above.
 */
function classifyAddress(address: string): AddressClass {
  const family = isIP(address)
  if (family === 4) {
    const o = address.split('.').map((part) => Number.parseInt(part, 10))
    // Cloud metadata endpoint: explicit class so we surface it distinctly.
    // 169.254.169.254 is AWS/GCP/Azure/Hetzner; classify before the broader
    // 169.254.0.0/16 link-local check.
    if (o[0] === 169 && o[1] === 254 && o[2] === 169 && o[3] === 254) {
      return 'metadata_address'
    }
    if (o[0] === 169 && o[1] === 254) return 'link_local_address'
    if (o[0] === 127) return 'loopback_address'
    if (PRIVATE_V4.check(address, 'ipv4')) return 'private_address'
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'cgnat_address'
    if (o[0] === 0) return 'unspecified_address'
    if (UNSAFE_V4.check(address, 'ipv4')) return 'unsafe_address'
    return 'public'
  }

  if (family !== 6) return 'unsafe_address'
  const v6 = address.toLowerCase()
  if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1') return 'loopback_address'
  if (v6 === '::' || v6 === '0:0:0:0:0:0:0:0') return 'unspecified_address'
  if (/^f[cd]/.test(v6)) return 'private_address'
  if (/^fe[89ab]/.test(v6)) return 'link_local_address'
  if (!GLOBAL_UNICAST_V6.check(address, 'ipv6')) return 'unsafe_address'
  if (NON_GLOBAL_UNICAST_V6.check(address, 'ipv6')) return 'unsafe_address'
  return 'public'
}

export const __TESTING__ = { classifyAddress }
