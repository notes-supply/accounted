import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { X509Certificate } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { pinnedHttpsFetch } from '@/lib/webhooks/pinned-fetch'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'

const IP_SAN_CERTIFICATE = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIUSdnbFdzbgfgywCQ2xiCgZuLQhmUwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjYwODEwMTI1MjA1WhcNMjYw
ODExMTI1MjA1WjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBAKCjYT9/vq94x+9Mq7knWyUvEqAlezIac34eZqNH
uRJonxLk+fsHPhDVKnqRu6nrr2QdOBHexiP2p6s0N2irVslQePjHzEDwMmJJQEh/
2J4DTuhf4C5kQGGId0ieByUNQSbIFLvq0hBKnl6S4+Ea0m9dHRL/AmkNGRMUdTaL
e/+CrhGzMBF/IT+yZRPE9XgpVpFCFPZE/q5PtTeX8aczX5Bvcmbr7tUltBQaBu4w
ND2L/NCynmqQD8LyWlNpcn6W4XBDIqA3CodnjmOgVgEB90mvG//U2c2ZkQGen+KI
E6RkAov/rlckbFn3O++hFymPjHdbQosO5PNvc7rwtqqaB1kCAwEAAaOBhDCBgTAd
BgNVHQ4EFgQUk2LZmT15SAahYtwrEntkVgqythYwHwYDVR0jBBgwFoAUk2LZmT15
SAahYtwrEntkVgqythYwDwYDVR0TAQH/BAUwAwEB/zAuBgNVHREEJzAlggtleGFt
cGxlLmNvbYcEywBxKocQJgZHAAAAAAAAAAAAAAARETANBgkqhkiG9w0BAQsFAAOC
AQEAO2cG7CChAikkRdGXpH9BbPKbW/vYJ7uVSD04jKoGDGg6rYYh6uda7wEgjvoU
6pnablSr4/8lW+8YCk4bzuFvGdYyo94uChe0Aibs7y0G6S7eeECPExjmupsgAAgk
urDVWmNsveSOVio0xxMld7twUMFqYhwZVfqKyqiOXWyQCeG17Tviazu4plJpPWTN
MNVto5p6TjInOhntd3G7MRU+2lQ2h3Zkmv4PBI2Xocn1vnAsKiYq1NDYVc1+ZtmQ
YfI4AngJ2jHF4rZrZqAXD07x/BaIeTDB3jp5eXuiyRn1wrQCSZy/uu9AndIzK5L+
NjODT2RPIuzScf0EIwK9yJVY8Q==
-----END CERTIFICATE-----`)

// Stand up a minimal stub for node:https.request that captures the args
// we want to assert on (pinned IP, SNI, Host header) and lets us synthesise
// a controlled response back to the caller.
function makeStubRequest(args: {
  status: number
  headers?: Record<string, string>
  body?: string
  emitError?: Error
  emitTimeout?: boolean
}) {
  const captured: {
    options: RequestOptions | null
    bodyWritten: string
  } = { options: null, bodyWritten: '' }

  const fakeRequest = (
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest => {
    captured.options = options

    const req = new EventEmitter() as ClientRequest & EventEmitter
    // ClientRequest API surface we touch in pinned-fetch:
    req.write = ((chunk: string) => {
      captured.bodyWritten += chunk
      return true
    }) as ClientRequest['write']
    req.end = (() => {
      // Dispatch the response (or error) asynchronously to mimic real
      // network timing: pinned-fetch attaches handlers BEFORE end().
      queueMicrotask(() => {
        if (args.emitError) {
          req.emit('error', args.emitError)
          return
        }
        if (args.emitTimeout) {
          req.emit('timeout')
          return
        }
        const res = new EventEmitter() as IncomingMessage & EventEmitter
        ;(res as unknown as { statusCode: number }).statusCode = args.status
        ;(res as unknown as { headers: Record<string, string> }).headers =
          args.headers ?? { 'content-type': 'application/json' }
        // IncomingMessage stubs need stream-shaped methods that pinned-fetch
        // calls (resume on redirect-drain, destroy on size truncation).
        ;(res as unknown as { resume: () => unknown }).resume = () => {
          /* no-op: body is already buffered in args.body */
        }
        ;(res as unknown as { destroy: () => unknown }).destroy = () => {
          // Truncation path: emit `close` so finalize() runs.
          queueMicrotask(() => res.emit('close'))
        }
        callback(res)
        // Emit body bytes then `end`.
        queueMicrotask(() => {
          if (args.body) res.emit('data', Buffer.from(args.body, 'utf8'))
          res.emit('end')
        })
      })
      return req
    }) as ClientRequest['end']
    req.destroy = (() => {
      // no-op: tests don't read the socket after destroy.
      return req
    }) as ClientRequest['destroy']
    req.setTimeout = (() => req) as ClientRequest['setTimeout']

    return req
  }

  return { captured, fakeRequest }
}

function makeStubValidator(addresses: string[]) {
  return vi.fn(async () => ({
    ok: true as const,
    hostname: 'example.com',
    resolvedAddresses: addresses,
  }))
}

function makeOversizeRaceRequest(
  events: string[],
  trigger: 'chunks' | 'content-length',
) {
  const req = new EventEmitter() as ClientRequest & EventEmitter
  const res = new EventEmitter() as IncomingMessage & EventEmitter
  const reqDestroy = vi.fn(() => req)
  const resDestroy = vi.fn(() => {
    for (const event of events) {
      if (event === 'error') res.emit('error', new Error('socket reset after destroy'))
      else res.emit(event)
    }
    return res
  })
  Object.assign(res, {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      ...(trigger === 'content-length' ? { 'content-length': '999' } : {}),
    },
    resume: vi.fn(),
    destroy: resDestroy,
  })
  req.write = vi.fn(() => true) as ClientRequest['write']
  req.destroy = reqDestroy as ClientRequest['destroy']
  req.setTimeout = vi.fn(() => req) as ClientRequest['setTimeout']
  req.end = (() => {
    queueMicrotask(() => {
      callback(res)
      if (trigger === 'chunks') {
        queueMicrotask(() => res.emit('data', Buffer.from('oversized')))
      }
    })
    return req
  }) as ClientRequest['end']
  let callback!: (response: IncomingMessage) => void
  const request = vi.fn(
    (_options: RequestOptions, responseCallback: (response: IncomingMessage) => void) => {
      callback = responseCallback
      return req
    },
  )
  return { request, reqDestroy, resDestroy }
}

describe('pinnedHttpsFetch', () => {
  it('pins the socket to the validated IP while keeping SNI + Host on the hostname', async () => {
    const { captured, fakeRequest } = makeStubRequest({
      status: 200,
      body: 'ok',
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      {
        method: 'POST',
        headers: { 'X-Gnubok-Event': 'invoice.paid' },
        body: '{"hello":"world"}',
        timeoutMs: 1000,
        maxResponseBytes: 1024,
      },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('unreachable')
    expect(result.status).toBe(200)
    expect(result.body).toBe('ok')
    expect(result.pinnedAddress).toBe('203.0.113.42')

    // Socket goes to the IP: DNS does not re-resolve.
    expect(captured.options?.host).toBe('203.0.113.42')
    // SNI carries the hostname so the receiver's TLS cert validates.
    expect(captured.options?.servername).toBe('example.com')
    // HTTP Host header carries the hostname for vhost routing.
    const headers = captured.options?.headers as Record<string, string>
    expect(headers.host).toBe('example.com')
    // Custom dispatcher header survives.
    expect(headers['X-Gnubok-Event']).toBe('invoice.paid')

    expect(captured.bodyWritten).toBe('{"hello":"world"}')

    const checkIdentity = captured.options?.checkServerIdentity
    expect(checkIdentity?.('ignored.example', {
      subjectaltname: 'DNS:example.com',
    } as never)).toBeUndefined()
    expect(checkIdentity?.('ignored.example', {
      subjectaltname: 'DNS:other.example.com',
    } as never)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('includes the port in the Host header when non-default', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 204 })

    await pinnedHttpsFetch(
      'https://example.com:8443/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(captured.options?.port).toBe(8443)
    const headers = captured.options?.headers as Record<string, string>
    expect(headers.host).toBe('example.com:8443')
  })

  it('normalizes an IPv4 literal for TLS identity and Host', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 204 })

    await pinnedHttpsFetch(
      'https://203.0.113.42/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(captured.options?.host).toBe('203.0.113.42')
    expect(captured.options?.servername).toBeUndefined()
    expect((captured.options?.headers as Record<string, string>).host).toBe('203.0.113.42')
    const checkIdentity = captured.options?.checkServerIdentity
    expect(checkIdentity).toBeTypeOf('function')
    expect(checkIdentity?.('ignored.example', {
      raw: IP_SAN_CERTIFICATE.raw,
    } as never)).toBeUndefined()
    expect(checkIdentity?.('ignored.example', {
      raw: new Uint8Array(IP_SAN_CERTIFICATE.raw),
    } as never)).toBeUndefined()

    const { captured: mismatch, fakeRequest: mismatchRequest } = makeStubRequest({ status: 204 })
    await pinnedHttpsFetch(
      'https://203.0.113.43/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.43']),
        httpsRequest: mismatchRequest,
      },
    )
    expect(mismatch.options?.checkServerIdentity?.('ignored.example', {
      raw: IP_SAN_CERTIFICATE.raw,
    } as never)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('uses an unbracketed IPv6 TLS/socket identity and a bracketed HTTP Host', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 204 })

    await pinnedHttpsFetch(
      'https://[2606:4700::1111]/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['2606:4700::1111']),
        httpsRequest: fakeRequest,
      },
    )

    expect(captured.options?.host).toBe('2606:4700::1111')
    expect(captured.options?.servername).toBeUndefined()
    expect((captured.options?.headers as Record<string, string>).host)
      .toBe('[2606:4700::1111]')
    expect(captured.options?.checkServerIdentity?.('ignored.example', {
      raw: IP_SAN_CERTIFICATE.raw,
    } as never)).toBeUndefined()

    const { captured: mismatch, fakeRequest: mismatchRequest } = makeStubRequest({ status: 204 })
    await pinnedHttpsFetch(
      'https://[2606:4700::1112]/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['2606:4700::1112']),
        httpsRequest: mismatchRequest,
      },
    )
    expect(mismatch.options?.checkServerIdentity?.('ignored.example', {
      raw: IP_SAN_CERTIFICATE.raw,
    } as never)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('fails malformed IP certificate evidence with a typed TLS identity error', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 204 })
    await pinnedHttpsFetch(
      'https://203.0.113.42/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(captured.options?.checkServerIdentity?.('ignored.example', {
      raw: Buffer.from('not-a-certificate'),
    } as never)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })

  it('times out stalled URL validation within the attempt budget and opens no socket', async () => {
    vi.useFakeTimers()
    try {
      let rejectLate!: (error: Error) => void
      const validateUrl = vi.fn(() => new Promise<never>((_resolve, reject) => {
        rejectLate = reject
      }))
      const { fakeRequest } = makeStubRequest({ status: 200 })
      const httpsRequest = vi.fn(fakeRequest)

      const pending = pinnedHttpsFetch(
        'https://example.com/hooks',
        { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
        { validateUrl: validateUrl as never, httpsRequest },
      )
      await vi.advanceTimersByTimeAsync(1000)

      await expect(pending).resolves.toMatchObject({
        kind: 'timeout',
        pinnedAddress: null,
      })
      expect(httpsRequest).not.toHaveBeenCalled()

      rejectLate(new Error('late resolver rejection'))
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the HTTPS request only the budget remaining after validation', async () => {
    vi.useFakeTimers()
    try {
      const validateUrl = vi.fn(() => new Promise<{
        ok: true
        hostname: string
        resolvedAddresses: string[]
      }>((resolve) => {
        setTimeout(() => resolve({
          ok: true,
          hostname: 'example.com',
          resolvedAddresses: ['203.0.113.42'],
        }), 600)
      }))
      const httpsRequest = vi.fn((
        _options: RequestOptions,
        _callback: (res: IncomingMessage) => void,
      ) => {
        const req = new EventEmitter() as ClientRequest & EventEmitter
        req.write = vi.fn(() => true) as never
        req.end = vi.fn(() => req) as never
        req.destroy = vi.fn(() => req) as never
        req.setTimeout = vi.fn(() => req) as never
        return req
      })

      const pending = pinnedHttpsFetch(
        'https://example.com/hooks',
        { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
        { validateUrl: validateUrl as never, httpsRequest },
      )
      await vi.advanceTimersByTimeAsync(600)
      expect(httpsRequest).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(399)
      let settled = false
      void pending.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ kind: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns unsafe_url when validation rejects the hostname', async () => {
    const { fakeRequest } = makeStubRequest({ status: 200 })
    const spyRequest = vi.fn(fakeRequest)
    const validator = vi.fn(async () => ({
      ok: false as const,
      reason: 'private_address' as const,
      detail: '10.0.0.1 is private',
    }))

    const result = await pinnedHttpsFetch(
      'https://internal.example/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      { validateUrl: validator, httpsRequest: spyRequest },
    )

    expect(result.kind).toBe('unsafe_url')
    if (result.kind === 'unsafe_url') {
      expect(result.reason).toBe('private_address')
      expect(result.pinnedAddress).toBeNull()
    }
    // Critically: we never opened a socket.
    expect(spyRequest).not.toHaveBeenCalled()
  })

  it.each(['100:0:0:1::1', '2001:5::1', '3fff::1', '5f00::1'])(
    'opens no connection when DNS includes non-global IPv6 %s',
    async (unsafeAddress) => {
      const { fakeRequest } = makeStubRequest({ status: 200 })
      const spyRequest = vi.fn(fakeRequest)
      const validateUrl = (rawUrl: string) => validateWebhookUrl(rawUrl, {
        resolve4: vi.fn().mockResolvedValue(['93.184.216.34']),
        resolve6: vi.fn().mockResolvedValue([unsafeAddress]),
      })

      const result = await pinnedHttpsFetch(
        'https://example.com/hooks',
        { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
        { validateUrl, httpsRequest: spyRequest },
      )

      expect(result).toMatchObject({ kind: 'unsafe_url', reason: 'unsafe_address' })
      expect(spyRequest).not.toHaveBeenCalled()
    },
  )

  it('treats 3xx responses as redirect_blocked', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 302,
      headers: { location: 'https://elsewhere.example/' },
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('redirect_blocked')
    if (result.kind === 'redirect_blocked') {
      expect(result.status).toBe(302)
      expect(result.pinnedAddress).toBe('203.0.113.42')
    }
  })

  it('maps transport errors to transport_error', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 0,
      emitError: new Error('ECONNREFUSED 203.0.113.42:443'),
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('transport_error')
    if (result.kind === 'transport_error') {
      expect(result.detail).toContain('ECONNREFUSED')
      expect(result.pinnedAddress).toBe('203.0.113.42')
    }
  })

  it('maps timeout events to timeout', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 0,
      emitTimeout: true,
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('timeout')
  })

  it('truncates response body at maxResponseBytes', async () => {
    const big = 'x'.repeat(10_000)
    const { fakeRequest } = makeStubRequest({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: big,
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 100 },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.body.length).toBe(100)
      expect(result.bodyTruncated).toBe(true)
    }
  })

  it('fails closed on an oversized response when strict sizing is requested', async () => {
    const { fakeRequest } = makeStubRequest({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"too":"large"}',
    })

    const result = await pinnedHttpsFetch(
      'https://example.com/store',
      {
        method: 'GET',
        headers: {},
        body: '',
        timeoutMs: 1000,
        maxResponseBytes: 4,
        rejectOversizeResponse: true,
      },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: fakeRequest,
      },
    )

    expect(result).toMatchObject({
      kind: 'response_too_large',
      pinnedAddress: '203.0.113.42',
    })
  })

  it.each(
    (['chunks', 'content-length'] as const).flatMap((trigger) => [
      ['error', 'aborted', 'close', 'end'],
      ['aborted', 'error', 'end', 'close'],
      ['close', 'error', 'aborted', 'end'],
      ['end', 'error', 'aborted', 'close'],
    ].map((events) => ({ trigger, events }))),
  )('keeps $trigger oversize terminal across response event order $events', async ({ trigger, events }) => {
    const { request, reqDestroy, resDestroy } = makeOversizeRaceRequest(events, trigger)
    const terminal = vi.fn()

    const result = await pinnedHttpsFetch(
      'https://example.com/store',
      {
        method: 'GET',
        headers: {},
        body: '',
        timeoutMs: 1000,
        maxResponseBytes: 4,
        rejectOversizeResponse: true,
      },
      {
        validateUrl: makeStubValidator(['203.0.113.42']),
        httpsRequest: request,
      },
    ).then((value) => {
      terminal(value)
      return value
    })

    expect(result).toMatchObject({ kind: 'response_too_large' })
    expect(terminal).toHaveBeenCalledOnce()
    expect(reqDestroy).toHaveBeenCalledOnce()
    expect(resDestroy).toHaveBeenCalledOnce()
  })

  it('picks the first resolved IP deterministically', async () => {
    const { captured, fakeRequest } = makeStubRequest({ status: 200 })

    await pinnedHttpsFetch(
      'https://example.com/hooks',
      { method: 'POST', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 1024 },
      {
        validateUrl: makeStubValidator(['203.0.113.42', '198.51.100.55']),
        httpsRequest: fakeRequest,
      },
    )

    // First entry, not the second, not random.
    expect(captured.options?.host).toBe('203.0.113.42')
  })
})
