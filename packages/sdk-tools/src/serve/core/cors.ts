export class CorsOriginError extends Error {
  readonly origin: string

  constructor(origin: string, message: string) {
    super(message)
    this.name = 'CorsOriginError'
    this.origin = origin
  }
}

export function normalizeCorsOrigin(origin: string): string {
  const value = origin.trim()
  if (value === '*') {
    throw new CorsOriginError(value, 'CORS wildcard origin is not allowed')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CorsOriginError(value, `CORS origin must be a valid HTTP(S) origin (got "${value}")`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CorsOriginError(value, `CORS origin must use http:// or https:// (got "${value}")`)
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin === 'null'
  ) {
    throw new CorsOriginError(
      value,
      `CORS origin must not include credentials, a path, query, or fragment (got "${value}")`
    )
  }
  // Browsers send the fully-qualified name without the root label, so an entry
  // carrying one is a silently dead allowlist entry rather than a stricter match.
  if (url.hostname.endsWith('.')) {
    throw new CorsOriginError(
      value,
      `CORS origin must not end in a trailing dot; browsers never send one (got "${value}")`
    )
  }

  return url.origin
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true
  }

  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

export function createCorsOriginMatcher(
  origins: readonly string[]
): (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void
) => void {
  const allowedOrigins = new Set(origins.map(normalizeCorsOrigin))

  return function (origin, callback): void {
    if (origin === undefined) {
      callback(null, true)
      return
    }

    try {
      callback(null, allowedOrigins.has(normalizeCorsOrigin(origin)))
    } catch {
      callback(null, false)
    }
  }
}
