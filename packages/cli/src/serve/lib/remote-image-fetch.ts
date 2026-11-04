import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'

export class RemoteImageFetchError extends Error {
  constructor() {
    super('could not fetch the image')
    this.name = 'RemoteImageFetchError'
  }
}

export class RemoteImageTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`image exceeds the ${maxBytes / (1024 * 1024)} MB limit`)
    this.name = 'RemoteImageTooLargeError'
  }
}

type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

export interface RemoteImageFetchOptions {
  maxBytes: number
  timeoutMs: number
  maxRedirects?: number
  resolve?: Resolver
  isBlockedAddress?: (address: string) => boolean
}

// IANA special-purpose ranges: loopback, private, CGNAT, link-local (cloud
// metadata), documentation, multicast, reserved, and IPv6 prefixes that embed
// an IPv4 address (NAT64, 6to4, Teredo, IPv4-compatible).
const blockedRanges = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedRanges.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const) {
  blockedRanges.addSubnet(net, prefix, 'ipv6')
}

const MAPPED_IPV4_RE = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i
const MAPPED_IPV4_HEX_RE = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i

function unmapIPv4(address: string): string {
  const dotted = MAPPED_IPV4_RE.exec(address)
  if (dotted) return dotted[1]!
  const hex = MAPPED_IPV4_HEX_RE.exec(address)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return address
}

export function isBlockedAddress(address: string): boolean {
  const normalized = unmapIPv4(address.replace(/%.*$/, ''))
  const family = isIP(normalized)
  if (family === 0) return true
  return blockedRanges.check(normalized, family === 4 ? 'ipv4' : 'ipv6')
}

// Checks every resolved address at connect time, so a name that only resolves
// to a blocked address when the socket opens (DNS rebinding) is refused too.
function guardedLookup(resolve: Resolver, isBlocked: (address: string) => boolean): LookupFunction {
  return function lookup(hostname, options, callback) {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (addresses.length === 0 || addresses.some((a) => isBlocked(a.address))) {
        return callback(new RemoteImageFetchError(), '', 0)
      }
      if (options.all) return callback(null, addresses)
      const first = addresses[0]!
      callback(null, first.address, first.family)
    })
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function requestOnce(
  url: URL,
  lookup: LookupFunction,
  signal: AbortSignal
): Promise<http.IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(url, { agent: false, lookup, signal }, resolve)
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBytes) {
      res.destroy()
      throw new RemoteImageTooLargeError(maxBytes)
    }
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks, total))
}

// Fetches a public HTTP(S) image. Loopback, private, link-local and metadata
// addresses are refused on every hop. Every failure other than the size limit
// surfaces as the same RemoteImageFetchError so callers cannot probe the
// server's network through status codes, timeouts or connection errors.
export async function fetchRemoteImage(
  rawUrl: string,
  options: RemoteImageFetchOptions
): Promise<Uint8Array> {
  const isBlocked = options.isBlockedAddress ?? isBlockedAddress
  const lookup = guardedLookup(options.resolve ?? (dnsLookup as Resolver), isBlocked)
  const signal = AbortSignal.timeout(options.timeoutMs)
  const maxRedirects = options.maxRedirects ?? 5

  try {
    let url = new URL(rawUrl)
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteImageFetchError()
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (isIP(host) !== 0 && isBlocked(host)) throw new RemoteImageFetchError()

      const res = await requestOnce(url, lookup, signal)
      const status = res.statusCode ?? 0
      if (REDIRECT_STATUSES.has(status) && res.headers.location) {
        res.resume()
        if (hop >= maxRedirects) throw new RemoteImageFetchError()
        url = new URL(res.headers.location, url)
        continue
      }
      if (status < 200 || status >= 300) {
        res.resume()
        throw new RemoteImageFetchError()
      }
      return await readBody(res, options.maxBytes)
    }
  } catch (err) {
    if (err instanceof RemoteImageTooLargeError) throw err
    throw new RemoteImageFetchError()
  }
}
