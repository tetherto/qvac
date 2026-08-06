export function normalizeCorsOrigin(origin: string): string {
  const value = origin.trim()
  if (value === '*') {
    throw new Error('CORS wildcard origin is not allowed')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`CORS origin must be a valid HTTP(S) origin (got "${value}")`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`CORS origin must use http:// or https:// (got "${value}")`)
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin === 'null'
  ) {
    throw new Error(
      `CORS origin must not include credentials, a path, query, or fragment (got "${value}")`
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
