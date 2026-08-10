import { describe, expect, it, vi } from 'vitest'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'

function noRecords() {
  return Object.assign(new Error('no records'), { code: 'ENODATA' })
}

describe('validateWebhookUrl address safety', () => {
  it('rejects a mixed public/private A set', async () => {
    const result = await validateWebhookUrl('https://shop.example.test/path', {
      resolve4: vi.fn().mockResolvedValue(['93.184.216.34', '10.0.0.8']),
      resolve6: vi.fn().mockRejectedValue(noRecords()),
    })

    expect(result).toMatchObject({ ok: false, reason: 'private_address' })
  })

  it('rejects a private AAAA record even when every A record is public', async () => {
    const result = await validateWebhookUrl('https://shop.example.test/path', {
      resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
      resolve6: vi.fn().mockResolvedValue(['fd00::1']),
    })

    expect(result).toMatchObject({ ok: false, reason: 'private_address' })
  })

  it.each([
    ['100:0:0:1::1', 'discard-only'],
    ['2001:5::1', 'IETF protocol assignment'],
    ['3fff::1', 'documentation'],
    ['5f00::1', 'segment-routing SIDs'],
  ])('rejects a mixed public A and non-global %s AAAA answer (%s)', async (address) => {
    const result = await validateWebhookUrl('https://shop.example.test/path', {
      resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
      resolve6: vi.fn().mockResolvedValue([address]),
    })

    expect(result).toMatchObject({ ok: false, reason: 'unsafe_address' })
  })

  it('fails closed when either address family has a hard DNS failure', async () => {
    const dnsFailure = Object.assign(new Error('resolver timeout'), { code: 'ETIMEOUT' })
    const result = await validateWebhookUrl('https://shop.example.test/path', {
      resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
      resolve6: vi.fn().mockRejectedValue(dnsFailure),
    })

    expect(result).toMatchObject({ ok: false, reason: 'dns_lookup_failed' })
  })

  it.each([
    ['https://127.0.0.1/path', 'loopback_address'],
    ['https://0.0.0.0/path', 'unspecified_address'],
    ['https://169.254.169.254/path', 'metadata_address'],
    ['https://100.64.0.1/path', 'cgnat_address'],
    ['https://224.0.0.1/path', 'unsafe_address'],
    ['https://[::1]/path', 'loopback_address'],
    ['https://[::]/path', 'unspecified_address'],
    ['https://[fc00::1]/path', 'private_address'],
    ['https://[fe80::1]/path', 'link_local_address'],
    ['https://[ff02::1]/path', 'unsafe_address'],
  ])('rejects unsafe literal %s without DNS', async (url, reason) => {
    const resolve4 = vi.fn()
    const resolve6 = vi.fn()

    const result = await validateWebhookUrl(url, { resolve4, resolve6 })

    expect(result).toMatchObject({ ok: false, reason })
    expect(resolve4).not.toHaveBeenCalled()
    expect(resolve6).not.toHaveBeenCalled()
  })

  it.each([
    ['https://[::ffff:192.0.2.1]/path', 'IPv4-mapped'],
    ['https://[::192.0.2.1]/path', 'IPv4-compatible'],
    ['https://[64:ff9b::808:808]/path', 'NAT64 well-known prefix'],
    ['https://[64:ff9b:1::808:808]/path', 'NAT64 local-use prefix'],
    ['https://[100::1]/path', 'discard-only'],
    ['https://[2001::1]/path', 'IETF protocol assignment'],
    ['https://[2001:2::1]/path', 'benchmarking'],
    ['https://[2001:5::1]/path', 'IETF protocol assignment subrange'],
    ['https://[2001:10::1]/path', 'ORCHID'],
    ['https://[2001:20::1]/path', 'ORCHIDv2'],
    ['https://[2001:db8::1]/path', 'documentation'],
    ['https://[2002:c000:201::1]/path', '6to4'],
    ['https://[2620:4f:8000::1]/path', 'Direct Delegation AS112'],
    ['https://[3fff::1]/path', 'documentation'],
    ['https://[5f00::1]/path', 'segment-routing SIDs'],
    ['https://[fec0::1]/path', 'deprecated site-local'],
  ])('rejects IANA non-global IPv6 literal %s (%s)', async (url) => {
    const result = await validateWebhookUrl(url)

    expect(result).toMatchObject({ ok: false, reason: 'unsafe_address' })
  })

  it.each([
    'https://[2606:4700::1111]/path',
    'https://[2001:4860:4860::8888]/path',
  ])('accepts ordinary global-unicast IPv6 literal %s', async (url) => {
    await expect(validateWebhookUrl(url)).resolves.toMatchObject({ ok: true })
  })

  it('rejects mixed DNS containing Direct Delegation AS112 without opening a socket downstream', async () => {
    const result = await validateWebhookUrl('https://shop.example.test/path', {
      resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
      resolve6: vi.fn().mockResolvedValue(['2620:4f:8000::53']),
    })

    expect(result).toMatchObject({ ok: false, reason: 'unsafe_address' })
  })
})
