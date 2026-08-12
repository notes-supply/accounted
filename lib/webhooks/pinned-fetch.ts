/**
 * Pinned-IP HTTPS POST for webhook dispatch.
 *
 * Closes the DNS-rebinding window between url-guard validation and the
 * actual HTTPS request. The previous shape was:
 *
 *   1. validateWebhookUrl()  → DNS resolves to [public IP], returns ok
 *   2. fetch(webhook_url)    → re-resolves DNS; an attacker who flipped
 *                              the A record in the interval gets a
 *                              private-IP socket
 *
 * The new shape pins the request to the IP validated in step 1, with the
 * original hostname carried in:
 *   - the TLS SNI extension (so the receiver's cert continues to match)
 *   - the HTTP Host header (so vhost routing on the receiver continues to
 *     work)
 *
 * The request socket therefore never re-resolves DNS, foreclosing the
 * rebind race. Documented openly per the url-guard.ts file header
 * ("closing that requires a custom HTTPS agent that pins the resolved IP").
 *
 * Built on `node:https.request` rather than undici's Agent because (a) the
 * project doesn't take a dependency on undici, (b) the stdlib API is more
 * explicit about the SNI / Host / IP split, (c) https.request is enough
 * for HTTP/1.1 + TLS, which every webhook receiver supports.
 *
 * Inversion seam: `httpsRequest` injectable for tests so we don't need to
 * stand up an HTTPS server to verify the pinning / SNI / Host shape. The
 * dispatcher's tests pass a stub through `pinnedFetchImpl`.
 */

import {
  request as httpsRequestDefault,
  type RequestOptions as HttpsRequestOptions,
} from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { checkServerIdentity as checkServerIdentityDefault } from 'node:tls'
import { validateWebhookUrl as validateWebhookUrlDefault } from './url-guard'

export type PinnedFetchResult =
  | {
      kind: 'ok'
      status: number
      headers: Record<string, string>
      body: string
      bodyTruncated: boolean
      pinnedAddress: string
    }
  | { kind: 'unsafe_url'; reason: string; detail: string; pinnedAddress: null }
  | { kind: 'redirect_blocked'; status: number; detail: string; pinnedAddress: string }
  | { kind: 'response_too_large'; detail: string; pinnedAddress: string }
  | { kind: 'timeout'; detail: string; pinnedAddress: string | null }
  | { kind: 'transport_error'; detail: string; pinnedAddress: string | null }

export interface PinnedFetchInit {
  method: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  /** Max bytes captured from response body: receivers returning long error pages get truncated. */
  maxResponseBytes: number
  /** Reject instead of returning a truncated body. Defaults to false for webhook compatibility. */
  rejectOversizeResponse?: boolean
}

export interface PinnedFetchDeps {
  /** DNS validation seam. Defaults to url-guard's validateWebhookUrl. */
  validateUrl?: typeof validateWebhookUrlDefault
  /** Raw HTTPS request seam. Defaults to node:https.request. */
  httpsRequest?: (
    options: HttpsRequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => ClientRequest
}

function ipCertificateIdentityError(
  hostname: string,
  detail: string,
  cause?: unknown,
): Error {
  const error = new Error(
    `IP certificate identity verification failed for ${hostname}: ${detail}`,
    cause === undefined ? undefined : { cause },
  ) as Error & { code: string; reason: string; host: string }
  error.code = 'ERR_TLS_CERT_ALTNAME_INVALID'
  error.reason = detail
  error.host = hostname
  return error
}

function checkIpServerIdentity(
  hostname: string,
  cert: Parameters<typeof checkServerIdentityDefault>[1],
): Error | undefined {
  try {
    const x509 = new X509Certificate(cert.raw)
    if (x509.checkIP(hostname) !== undefined) return undefined
    return ipCertificateIdentityError(
      hostname,
      'certificate does not contain an exact matching IP subject alternative name',
    )
  } catch (error) {
    return ipCertificateIdentityError(hostname, 'certificate could not be parsed', error)
  }
}

export async function pinnedHttpsFetch(
  rawUrl: string,
  init: PinnedFetchInit,
  deps: PinnedFetchDeps = {},
): Promise<PinnedFetchResult> {
  const validateUrl = deps.validateUrl ?? validateWebhookUrlDefault
  const httpsRequest = deps.httpsRequest ?? httpsRequestDefault
  const deadlineAt = Date.now() + init.timeoutMs

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return {
      kind: 'unsafe_url',
      reason: 'invalid_url',
      detail: 'URL did not parse.',
      pinnedAddress: null,
    }
  }

  type ValidationOutcome =
    | { kind: 'completed'; value: Awaited<ReturnType<typeof validateUrl>> }
    | { kind: 'failed'; error: unknown }
    | { kind: 'timeout' }
  const validationOutcome = await new Promise<ValidationOutcome>((resolve) => {
    let completed = false
    const finish = (outcome: ValidationOutcome) => {
      if (completed) return
      completed = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const remaining = Math.max(0, deadlineAt - Date.now())
    const timer = setTimeout(() => finish({ kind: 'timeout' }), remaining)
    Promise.resolve()
      .then(() => validateUrl(rawUrl))
      .then(
        (value) => finish({ kind: 'completed', value }),
        (error) => finish({ kind: 'failed', error }),
      )
  })
  if (validationOutcome.kind === 'timeout') {
    return {
      kind: 'timeout',
      detail: `URL validation exceeded ${init.timeoutMs} ms wall-clock`,
      pinnedAddress: null,
    }
  }
  if (validationOutcome.kind === 'failed') {
    const detail = validationOutcome.error instanceof Error
      ? validationOutcome.error.message
      : String(validationOutcome.error)
    return { kind: 'transport_error', detail, pinnedAddress: null }
  }
  const validation = validationOutcome.value
  if (!validation.ok) {
    return {
      kind: 'unsafe_url',
      reason: validation.reason,
      detail: validation.detail,
      pinnedAddress: null,
    }
  }

  // Pick the first vetted address. validateWebhookUrl rejects the whole
  // set when ANY entry is unsafe, so the first is safe by construction.
  // Deterministic choice keeps log output stable across retries.
  const rawPinnedAddress = validation.resolvedAddresses[0]
  const pinnedAddress = rawPinnedAddress?.startsWith('[') && rawPinnedAddress.endsWith(']')
    ? rawPinnedAddress.slice(1, -1)
    : rawPinnedAddress
  if (!pinnedAddress) {
    // Defensive: validateWebhookUrl returns ok only when there's at least
    // one address, but a future refactor could regress this and we want
    // the failure to be loud, not a silent DNS-lookup-by-empty-host.
    return {
      kind: 'transport_error',
      detail: 'No resolved address from validateWebhookUrl',
      pinnedAddress: null,
    }
  }

  const port = parsed.port ? Number(parsed.port) : 443
  const urlHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  const literalHostname = isIP(urlHostname) !== 0
  const remainingRequestMs = Math.max(0, deadlineAt - Date.now())
  if (remainingRequestMs === 0) {
    return {
      kind: 'timeout',
      detail: `Request exceeded ${init.timeoutMs} ms wall-clock during URL validation`,
      pinnedAddress,
    }
  }

  return new Promise<PinnedFetchResult>((resolve) => {
    let settled = false
    const settle = (r: PinnedFetchResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }

    // The HTTP Host header must carry the original hostname (vhost routing
    // on the receiver). Include the port only when non-default: RFC 7230
    // §5.4 says the port is omitted when it matches the scheme default.
    const hostHeader = port === 443 ? parsed.hostname : `${parsed.hostname}:${port}`

    const requestOptions: HttpsRequestOptions = {
      protocol: 'https:',
      // Pin the socket to the validated IP. node:https accepts the
      // address directly: no further DNS lookup happens.
      host: pinnedAddress,
      port,
      path: parsed.pathname + parsed.search,
      method: init.method,
      // DNS names keep their original SNI. IP literals omit SNI because TLS
      // servername values cannot be bracketed IPv6 or an IP address.
      ...(!literalHostname ? { servername: urlHostname } : {}),
      // Pin certificate verification to the original normalized URL identity.
      // DNS names verify their DNS SAN/CN; IP literals verify an exact IP SAN.
      checkServerIdentity: (_hostname, cert) => literalHostname
        ? checkIpServerIdentity(urlHostname, cert)
        : checkServerIdentityDefault(urlHostname, cert),
      headers: {
        ...init.headers,
        // Lowercase 'host': Node's https.request would synthesise one
        // from `host` (the pinned IP) if we didn't set it explicitly,
        // which would break vhost routing on the receiver.
        host: hostHeader,
      },
      // Fresh socket per call: webhook delivery doesn't benefit from
      // Keep-Alive (the dispatcher serializes and the IP changes per
      // dispatch from re-validation). agent:false also forecloses any
      // accidental pool-level reuse across pinned IPs.
      agent: false,
    }

    let absoluteTimer: NodeJS.Timeout | null = null

    const req = httpsRequest(requestOptions, (res) => {
      // Receivers MUST return a non-redirect. Following a 3xx would let
      // them bounce the dispatcher to a private address AFTER the SSRF
      // guard cleared. We don't follow redirects; treat as terminal here
      // and let the dispatcher mark the row dead with reason='redirect_
      // blocked' for consistency with the old fetch path's behavior.
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        // Drain body so the socket cleans up; ignore errors.
        res.resume()
        req.destroy()
        if (absoluteTimer) clearTimeout(absoluteTimer)
        return settle({
          kind: 'redirect_blocked',
          status,
          detail: `Receiver returned ${status}; redirects are refused.`,
          pinnedAddress,
        })
      }

      const contentLength = Number(res.headers['content-length'])
      let oversizeDetected = false
      let requestDestroyed = false
      let responseDestroyed = false
      const destroyRequestOnce = () => {
        if (requestDestroyed) return
        requestDestroyed = true
        req.destroy()
      }
      const destroyResponseOnce = () => {
        if (responseDestroyed) return
        responseDestroyed = true
        res.destroy()
      }
      const rejectOversize = () => {
        if (oversizeDetected) return
        oversizeDetected = true
        if (absoluteTimer) clearTimeout(absoluteTimer)
        settle({
          kind: 'response_too_large',
          detail: `Response exceeded ${init.maxResponseBytes} bytes.`,
          pinnedAddress,
        })
        // Settle and mark the terminal condition before destruction because
        // either stream may synchronously emit error/aborted/close.
        destroyResponseOnce()
        destroyRequestOnce()
      }
      // Register before the Content-Length fast path destroys the response.
      // Some stream implementations emit an error synchronously from destroy.
      res.on('error', (err) => {
        if (oversizeDetected) return
        if (absoluteTimer) clearTimeout(absoluteTimer)
        settle({ kind: 'transport_error', detail: err.message, pinnedAddress })
      })
      if (
        init.rejectOversizeResponse &&
        Number.isFinite(contentLength) &&
        contentLength > init.maxResponseBytes
      ) {
        rejectOversize()
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      let truncated = false

      res.on('data', (chunk: Buffer) => {
        if (truncated) return
        if (total + chunk.length > init.maxResponseBytes) {
          const remaining = init.maxResponseBytes - total
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
          total = init.maxResponseBytes
          truncated = true
          if (init.rejectOversizeResponse) {
            rejectOversize()
          } else {
            // Destroy the stream: no point pulling the rest over the wire.
            destroyResponseOnce()
          }
        } else {
          chunks.push(chunk)
          total += chunk.length
        }
      })

      const finalize = () => {
        if (absoluteTimer) clearTimeout(absoluteTimer)
        if (oversizeDetected) return
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k] = v
          else if (Array.isArray(v)) headers[k] = v.join(', ')
        }
        settle({
          kind: 'ok',
          status,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bodyTruncated: truncated,
          pinnedAddress,
        })
      }

      // Two completion paths to handle: 'end' (normal completion) and
      // 'close' (when we destroyed the stream for size truncation, where
      // 'end' does not fire). Node emits BOTH 'end' and 'close' on normal
      // completions, so `once()` + a self-removing pair keeps finalize
      // single-shot without relying on the outer `settled` guard to
      // squash duplicate header reconstruction.
      const finalizeOnce = () => {
        res.removeListener('end', finalizeOnce)
        res.removeListener('close', finalizeOnce)
        finalize()
      }
      res.once('end', finalizeOnce)
      res.once('close', finalizeOnce)
    })

    // Two-layer timeout: socket-idle timeout via Node's built-in, plus a
    // wall-clock absolute timeout. node:https `timeout` is idle-only and
    // wouldn't fire if a slow receiver dribbles bytes; the absolute timer
    // is the hard cap.
    req.setTimeout(remainingRequestMs)
    req.on('timeout', () => {
      if (settled) return
      req.destroy()
      if (absoluteTimer) clearTimeout(absoluteTimer)
      settle({
        kind: 'timeout',
        detail: `Socket idle for ${remainingRequestMs} ms`,
        pinnedAddress,
      })
    })

    absoluteTimer = setTimeout(() => {
      if (settled) return
      req.destroy()
      settle({
        kind: 'timeout',
        detail: `Request exceeded ${init.timeoutMs} ms wall-clock`,
        pinnedAddress,
      })
    }, remainingRequestMs)

    req.on('error', (err) => {
      if (settled) return
      if (absoluteTimer) clearTimeout(absoluteTimer)
      settle({ kind: 'transport_error', detail: err.message, pinnedAddress })
    })

    if (init.body) req.write(init.body)
    req.end()
  })
}
