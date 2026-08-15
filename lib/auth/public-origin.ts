import { isIP } from 'node:net'

const LEGACY_PUBLIC_HOST = 'app.gnubok.se'

/**
 * Resolve the browser-visible origin for authentication redirects.
 *
 * Private ingress addresses and forwarded headers are never trusted. A
 * deployment behind private ingress must supply NEXT_PUBLIC_APP_URL. Hosted
 * deployments retain the request-origin fallback only for public HTTPS
 * origins. The one legacy OAuth host is an exact, explicit compatibility
 * exception.
 */
export function resolvePublicOrigin(request: Request): string | null {
  if (requestHostname(request) === LEGACY_PUBLIC_HOST) {
    return `https://${LEGACY_PUBLIC_HOST}`
  }

  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (configured) return parseConfiguredOrigin(configured)

  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return null

  let requestUrl: URL
  try {
    requestUrl = new URL(request.url)
  } catch {
    return null
  }

  if (requestUrl.protocol !== 'https:' || isInternalHostname(requestUrl.hostname)) {
    return null
  }

  return requestUrl.origin
}

function parseConfiguredOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return null
  }

  return url.origin
}

function requestHostname(request: Request): string | null {
  const host = request.headers.get('host')?.trim()
  if (host) {
    try {
      return new URL(`https://${host}`).hostname.toLowerCase()
    } catch {
      return null
    }
  }

  try {
    return new URL(request.url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    !normalized.includes('.')
  ) {
    return true
  }

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) {
    const [first, second] = normalized.split('.').map(Number)
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    )
  }

  if (ipVersion === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    )
  }

  return false
}
