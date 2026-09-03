// Transport and integrity rules for HTTP model downloads.
//
// Unverified bring-your-own HTTP sources are trusted on transport alone, so the
// transport must actually protect the bytes: plaintext http:// gives a network
// attacker a silent swap of the model, and an https:// URL that redirects to
// http:// (SSL-stripping) reopens the same hole. Loopback never touches the
// network, so it is exempt. Hugging Face is the one source that also ships an
// integrity hash (the Hub's SHA-256, surfaced as the X-Linked-Etag header on
// the resolve response before the CDN redirect), which we verify downloads
// against.

const HUGGING_FACE_HOSTS = new Set(['huggingface.co', 'hf.co'])

export type HeaderBag = Record<string, string | string[] | number | undefined>

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase())
  if (h === 'localhost' || h === '::1') return true
  // Match the 127.0.0.0/8 block as an actual IPv4 address, not a string prefix:
  // `127.0.0.1.evil.com` and `127.example.com` are registrable domains, not loopback.
  const m = IPV4_LOOPBACK.exec(h)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

export function isHuggingFaceHost(host: string): boolean {
  return HUGGING_FACE_HOSTS.has(host.trim().toLowerCase())
}

/**
 * Whether an HTTP(S) URL may be used for a model download. HTTPS is always
 * allowed; plaintext HTTP only for loopback. Other schemes are out of scope
 * here and return false.
 */
export function isSecureDownloadUrl(url: string | URL): boolean {
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol === 'http:') return isLoopbackHost(parsed.hostname)
  return false
}

function firstHeaderValue(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()]
  const raw = Array.isArray(value) ? value[0] : value
  return raw === undefined ? undefined : String(raw)
}

function normalizeEtag(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('W/')) value = value.slice(2).trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  return value
}

const SHA256_HEX = /^[0-9a-f]{64}$/i

/**
 * Extract the Hugging Face Hub SHA-256 from a response's headers, if present.
 * The Hub publishes it as `X-Linked-Etag` (and `ETag` for LFS files) — the
 * content SHA-256 for LFS-backed files. A non-LFS file yields a git blob
 * SHA-1 (40 hex) or a CDN etag instead; those are not SHA-256 and return
 * undefined so the caller treats the download as unverifiable.
 */
export function extractHubSha256(headers: HeaderBag): string | undefined {
  const raw = firstHeaderValue(headers, 'x-linked-etag') ?? firstHeaderValue(headers, 'etag')
  if (!raw) return undefined
  const value = normalizeEtag(raw)
  return SHA256_HEX.test(value) ? value.toLowerCase() : undefined
}
