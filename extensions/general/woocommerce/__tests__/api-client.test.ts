import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import {
  listOrdersPage,
  listOrderRefunds,
  testConnectionAndFetchStoreInfo,
  wcGet,
  WooCommerceApiError,
  WooCommerceDeadlineError,
  type WooApiClientDeps,
  type WooCredentials,
} from '../lib/api-client'

const CREDS: WooCredentials = {
  storeUrl: 'https://shop.example.se',
  consumerKey: 'ck_test',
  consumerSecret: 'cs_test',
}

describe('listOrdersPage', () => {
  it('bounds an exact cohort strictly and orders it by stable order ID', async () => {
    const pinnedFetch = vi.fn().mockResolvedValue(pinnedJson(200, [], {
      'x-wp-total': '0',
      'x-wp-totalpages': '0',
    }))

    await listOrdersPage(
      CREDS,
      {
        modifiedAfter: '2026-08-01T09:04:59.000Z',
        modifiedBefore: '2026-08-01T09:05:01.000Z',
        orderBy: 'id',
        page: 7,
      },
      { pinnedFetch },
    )

    const url = new URL(String(pinnedFetch.mock.calls[0][0]))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      modified_after: '2026-08-01T09:04:59.000Z',
      modified_before: '2026-08-01T09:05:01.000Z',
      dates_are_gmt: 'true',
      orderby: 'id',
      order: 'asc',
      page: '7',
    })
  })
})

function makeRefunds(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    amount: '10.00',
    reason: '',
    date_created_gmt: '2026-08-01T10:00:00',
  }))
}

function pinnedJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    kind: 'ok' as const,
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    bodyTruncated: false,
    pinnedAddress: '93.184.216.34',
  }
}

function noRecords() {
  return Object.assign(new Error('no records'), { code: 'ENODATA' })
}

function validatorWith(
  resolve4: () => Promise<string[]>,
  resolve6: () => Promise<string[]> = vi.fn().mockRejectedValue(noRecords()),
) {
  return (url: string) => validateWebhookUrl(url, { resolve4, resolve6 })
}

function makeHttpsRequest(
  responses: Array<{
    status?: number
    headers?: Record<string, string>
    body?: string
    timeout?: boolean
  }>,
) {
  const options: RequestOptions[] = []
  const request = vi.fn(
    (requestOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
      options.push(requestOptions)
      const responseSpec = responses.shift()
      if (!responseSpec) throw new Error('Unexpected HTTPS request')

      const req = new EventEmitter() as ClientRequest & EventEmitter
      req.write = vi.fn(() => true) as ClientRequest['write']
      req.destroy = vi.fn(() => req) as ClientRequest['destroy']
      req.setTimeout = vi.fn(() => req) as ClientRequest['setTimeout']
      req.end = (() => {
        queueMicrotask(() => {
          if (responseSpec.timeout) {
            req.emit('timeout')
            return
          }
          const response = new EventEmitter() as IncomingMessage & EventEmitter
          Object.assign(response, {
            statusCode: responseSpec.status ?? 200,
            headers: responseSpec.headers ?? { 'content-type': 'application/json' },
            resume: vi.fn(),
            destroy: vi.fn(() => queueMicrotask(() => response.emit('close'))),
          })
          callback(response)
          queueMicrotask(() => {
            if (responseSpec.body) response.emit('data', Buffer.from(responseSpec.body))
            response.emit('end')
          })
        })
        return req
      }) as ClientRequest['end']
      return req
    },
  )
  return { request, options }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unpinned fetch forbidden')))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WooCommerce pinned transport', () => {
  it('pins a public DNS result while preserving the original SNI and Host', async () => {
    const { request, options } = makeHttpsRequest([{ body: '{"ok":true}' }])

    await expect(
      wcGet<{ ok: boolean }>(CREDS, '/orders', {}, {
        validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
        httpsRequest: request,
      }),
    ).resolves.toEqual({ ok: true })

    expect(options[0].host).toBe('93.184.216.34')
    expect(options[0].servername).toBe('shop.example.se')
    expect(options[0].headers).toMatchObject({ host: 'shop.example.se' })
  })

  it.each([
    [['10.0.0.8'], []],
    [['93.184.216.34', '192.168.1.4'], []],
    [['93.184.216.34'], ['fd00::4']],
    [['93.184.216.34'], ['100:0:0:1::1']],
    [['93.184.216.34'], ['2001:5::1']],
    [['93.184.216.34'], ['3fff::1']],
    [['93.184.216.34'], ['5f00::1']],
  ])('rejects any unsafe A or AAAA result before opening a connection', async (v4, v6) => {
    const { request } = makeHttpsRequest([])

    await expect(
      wcGet(CREDS, '/orders', {}, {
        validateUrl: validatorWith(
          vi.fn().mockResolvedValue(v4),
          vi.fn().mockResolvedValue(v6),
        ),
        httpsRequest: request,
      }),
    ).rejects.toBeInstanceOf(WooCommerceApiError)
    expect(request).not.toHaveBeenCalled()
  })

  it('cannot rebind between validation and the socket connection', async () => {
    const resolve4 = vi.fn().mockResolvedValueOnce(['93.184.216.34'])
    const { request, options } = makeHttpsRequest([{ body: '[]' }])

    await wcGet(CREDS, '/orders', {}, {
      validateUrl: validatorWith(resolve4),
      httpsRequest: request,
    })

    expect(resolve4).toHaveBeenCalledOnce()
    expect(options[0].host).toBe('93.184.216.34')
  })

  it('rejects redirects terminally without following or exposing Location credentials', async () => {
    const { request } = makeHttpsRequest([
      {
        status: 302,
        headers: { location: 'https://user:secret@10.0.0.1/private' },
      },
    ])

    const promise = wcGet(CREDS, '/orders', {}, {
      validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
      httpsRequest: request,
    })

    await expect(promise).rejects.toMatchObject({ status: 302 })
    await expect(promise).rejects.not.toThrow(/user|secret|10\.0\.0\.1/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('fails closed on timeout and oversized JSON responses', async () => {
    const timeoutRequest = makeHttpsRequest([
      { timeout: true },
      { timeout: true },
      { timeout: true },
    ])
    await expect(
      wcGet(CREDS, '/orders', {}, {
        validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
        httpsRequest: timeoutRequest.request,
        requestTimeoutMs: 50,
        sleep: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 0 })

    const oversizedRequest = makeHttpsRequest([{ body: '{"large":true}' }])
    const oversizedSleep = vi.fn()
    await expect(
      wcGet(CREDS, '/orders', {}, {
        validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
        httpsRequest: oversizedRequest.request,
        maxResponseBytes: 4,
        sleep: oversizedSleep,
      }),
    ).rejects.toMatchObject({ status: 0 })
    expect(oversizedRequest.request).toHaveBeenCalledOnce()
    expect(oversizedSleep).not.toHaveBeenCalled()
  })

  it('treats rejected credentials as terminal without retrying them in the URL', async () => {
    const resolve4 = vi.fn().mockResolvedValue(['93.184.216.34'])
    const { request, options } = makeHttpsRequest([
      { status: 401, body: '{"code":"unauthorized"}' },
    ])

    await expect(
      wcGet(CREDS, '/orders', {}, {
        validateUrl: validatorWith(resolve4),
        httpsRequest: request,
      }),
    ).rejects.toMatchObject({ status: 401 })

    expect(resolve4).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
    expect(String(options[0].path)).not.toContain('consumer_')
  })

  it('redacts credentials echoed by a terminal authorization error', async () => {
    const { request } = makeHttpsRequest([
      {
        status: 403,
        body: '{"message":"rejected ck_test and cs_test"}',
      },
    ])

    const promise = wcGet(CREDS, '/orders', {}, {
      validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
      httpsRequest: request,
    })

    await expect(promise).rejects.not.toThrow(/ck_test|cs_test/)
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([401, 403])('redacts every reversible credential form from %i errors and logs', async (status) => {
    const creds: WooCredentials = {
      storeUrl: CREDS.storeUrl,
      consumerKey: 'ck_live/+?',
      consumerSecret: 'cs live:%',
    }
    const encodedKey = encodeURIComponent(creds.consumerKey)
    const encodedSecret = encodeURIComponent(creds.consumerSecret)
    const basicToken = Buffer.from(
      `${creds.consumerKey}:${creds.consumerSecret}`,
    ).toString('base64')
    const authorization = `bAsIc   ${basicToken}`
    const hostileMessage = [
      creds.consumerKey,
      creds.consumerSecret,
      encodedKey,
      encodedSecret,
      basicToken,
      authorization,
      `Authorization: ${authorization}`,
      `consumer_key=${encodedKey}&consumer_secret=${encodedSecret}`,
    ].join(' | ')
    const { request, options } = makeHttpsRequest([
      { status, body: JSON.stringify({ code: 'forbidden', message: hostileMessage }) },
    ])
    const sleep = vi.fn()
    const log = vi.fn()

    let caught: unknown
    try {
      await wcGet(creds, '/orders', {}, {
        validateUrl: validatorWith(vi.fn().mockResolvedValue(['93.184.216.34'])),
        httpsRequest: request,
        sleep,
      })
    } catch (error) {
      caught = error
      log(error instanceof Error ? error.message : String(error))
    }

    expect(caught).toMatchObject({ status, retryable: false })
    expect(request).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
    expect(String(options[0].path)).not.toMatch(/consumer_(?:key|secret)/i)
    const surfacedText = [
      caught instanceof Error ? caught.message : String(caught),
      ...log.mock.calls.flat().map(String),
    ].join('\n')
    for (const secretForm of [
      creds.consumerKey,
      creds.consumerSecret,
      encodedKey,
      encodedSecret,
      basicToken,
      authorization,
    ]) {
      expect(surfacedText).not.toContain(secretForm)
    }
    expect(surfacedText).not.toMatch(/authorization\s*:\s*basic/i)
    expect(surfacedText).not.toMatch(/consumer_(?:key|secret)\s*=/i)
  })

  it('revalidates every retry', async () => {
    const validateUrl = vi.fn().mockResolvedValue({
      ok: true,
      hostname: 'shop.example.se',
      resolvedAddresses: ['93.184.216.34'],
    })
    const { request } = makeHttpsRequest([
      { status: 503, body: '{"message":"busy"}' },
      { status: 200, body: '{"ok":true}' },
    ])

    await expect(
      wcGet(CREDS, '/orders', {}, {
        validateUrl,
        httpsRequest: request,
        sleep: vi.fn(),
      }),
    ).resolves.toEqual({ ok: true })

    expect(request).toHaveBeenCalledTimes(2)
    expect(validateUrl).toHaveBeenCalledTimes(2)
  })

  it('uses the pinned transport for the probe and every optional store-info request', async () => {
    const pinnedFetch = vi
      .fn()
      .mockResolvedValueOnce(pinnedJson(200, []))
      .mockResolvedValueOnce(pinnedJson(200, []))
      .mockResolvedValueOnce(pinnedJson(200, {}))
      .mockResolvedValueOnce(pinnedJson(200, { name: 'Safe Shop' }))

    await expect(
      testConnectionAndFetchStoreInfo(CREDS, { pinnedFetch }),
    ).resolves.toMatchObject({ name: 'Safe Shop' })

    expect(pinnedFetch).toHaveBeenCalledTimes(4)
    expect(pinnedFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://shop.example.se/wp-json/wc/v3/orders?per_page=1',
      'https://shop.example.se/wp-json/wc/v3/settings/general',
      'https://shop.example.se/wp-json/wc/v3/system_status',
      'https://shop.example.se/wp-json/',
    ])
  })
})

describe('listOrderRefunds', () => {
  function depsForBodies(
    bodies: unknown[],
    total: number,
    totalPages: number,
  ): WooApiClientDeps {
    const pinnedFetch = vi.fn()
    for (const body of bodies) {
      pinnedFetch.mockResolvedValueOnce(pinnedJson(200, body, {
        'x-wp-total': String(total),
        'x-wp-totalpages': String(totalPages),
      }))
    }
    return {
      pinnedFetch,
      validateUrl: vi.fn().mockResolvedValue({
        ok: true,
        hostname: 'shop.example.se',
        resolvedAddresses: ['93.184.216.34'],
      }),
      sleep: vi.fn(),
    }
  }

  it('uses collection metadata rather than a short page as completion proof', async () => {
    const deps = depsForBodies([makeRefunds(1, 50), makeRefunds(51, 50)], 100, 2)

    const refunds = await listOrderRefunds(CREDS, 42, deps)
    expect(refunds).toHaveLength(100)
    expect(deps.pinnedFetch).toHaveBeenCalledTimes(2)
  })

  it('fails when a host ignoring page repeats the same rows', async () => {
    const repeated = makeRefunds(1, 100)
    const deps = depsForBodies([repeated, repeated], 200, 2)

    await expect(listOrderRefunds(CREDS, 42, deps)).rejects.toThrow(
      /repeated or was not ID-monotonic/,
    )
    expect(deps.pinnedFetch).toHaveBeenCalledTimes(2)
  })

  it('throws instead of returning a silently partial list when the page cap is exhausted', async () => {
    const deps = depsForBodies([makeRefunds(1, 100)], 1100, 11)

    await expect(listOrderRefunds(CREDS, 42, deps)).rejects.toThrow(
      /Refund pagination cap exceeded/,
    )
    expect(deps.pinnedFetch).toHaveBeenCalledTimes(1)
  })

  it('does not start another refund page after the provider work-start deadline', async () => {
    let nowMs = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const deps = depsForBodies([], 200, 2)
    vi.mocked(deps.pinnedFetch!).mockImplementationOnce(async () => {
      nowMs = 10
      return pinnedJson(200, makeRefunds(1, 100), {
        'x-wp-total': '200',
        'x-wp-totalpages': '2',
      })
    })
    deps.startDeadlineMs = 10

    try {
      await expect(listOrderRefunds(CREDS, 42, deps)).rejects.toBeInstanceOf(
        WooCommerceDeadlineError,
      )
      expect(deps.pinnedFetch).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })

  it('fails closed when pagination metadata is omitted', async () => {
    const pinnedFetch = vi.fn().mockResolvedValue(pinnedJson(200, makeRefunds(1, 1)))
    await expect(listOrderRefunds(CREDS, 42, { pinnedFetch })).rejects.toThrow(
      /omitted valid x-wp-total/,
    )
  })
})
