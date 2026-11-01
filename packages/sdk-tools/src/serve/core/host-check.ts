import { isIP } from 'node:net'
import { isLoopbackHost } from '@/serve/core/cors'

export class AllowedHostError extends Error {
  readonly host: string

  constructor(host: string, message: string) {
    super(message)
    this.name = 'AllowedHostError'
    this.host = host
  }
}

/**
 * Validates an operator-supplied allowed host: a bare hostname, or `.example.com`
 * for the domain and every subdomain. Returned lowercased without a trailing dot.
 */
export function normalizeAllowedHost(entry: string): string {
  const value = entry.trim().toLowerCase().replace(/\.$/, '')
  const name = value.startsWith('.') ? value.slice(1) : value
  if (name === '' || name === '*' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(name)) {
    throw new AllowedHostError(
      entry,
      `Allowed host must be a hostname or .domain, without scheme, port or wildcard (got "${entry}")`
    )
  }
  return value
}

export interface HostMatcherOptions {
  /** The address the server binds to. */
  readonly bindHost: string
  /** Extra hostnames from `--allowed-host` / `serve.allowedHosts`; `true` allows any. */
  readonly allowedHosts: readonly string[] | true
  readonly publicBaseUrl?: string | null | undefined
}

/**
 * A DNS-rebinding page reaches the server under a hostname it controls, so only
 * hostnames need an allowlist: loopback names, IP literals, the bind host, the
 * public base URL's host and operator-listed names pass. The port is ignored.
 */
export function createHostMatcher(
  options: HostMatcherOptions
): (header: string | undefined) => boolean {
  if (options.allowedHosts === true) return () => true

  const exact = new Set<string>()
  const suffixes: string[] = []
  for (const entry of options.allowedHosts) {
    const host = normalizeAllowedHost(entry)
    if (host.startsWith('.')) {
      exact.add(host.slice(1))
      suffixes.push(host)
    } else {
      exact.add(host)
    }
  }
  const bindHost = hostnameOf(options.bindHost)
  if (bindHost !== null) exact.add(bindHost)
  if (options.publicBaseUrl) {
    const publicHost = hostnameOf(new URL(options.publicBaseUrl).host)
    if (publicHost !== null) exact.add(publicHost)
  }

  return function (header) {
    const host = hostnameOf(header)
    if (host === null) return false
    if (isLoopbackHost(host) || isIP(host.replace(/^\[(.*)\]$/, '$1')) !== 0) return true
    return exact.has(host) || suffixes.some((suffix) => host.endsWith(suffix))
  }
}

function hostnameOf(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null
  // A bare IPv6 bind address has no brackets; a Host header always does.
  const authority = isIP(value) === 6 ? `[${value}]` : value
  try {
    const url = new URL(`http://${authority}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}
