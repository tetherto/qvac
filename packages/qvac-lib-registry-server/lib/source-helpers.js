'use strict'

function ensureUrl (source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new TypeError('source must be a non-empty string')
  }
  return source.trim()
}

function normalizePath (value) {
  return value.replace(/^\/+/, '')
}

function parseCanonicalSource (source) {
  const trimmed = ensureUrl(source)

  if (trimmed.startsWith('s3://')) {
    const url = new URL(trimmed)
    const bucket = url.hostname
    const key = normalizePath(url.pathname)
    return {
      canonicalUrl: trimmed,
      path: key,
      filename: key.split('/').pop(),
      protocol: 's3',
      bucket,
      key
    }
  }

  const url = new URL(trimmed)
  const pathname = normalizePath(url.pathname)
  // Decode URL-encoded path components (e.g., %C3%A3 -> ã)
  const decodedPathname = decodeURIComponent(pathname)

  if (url.protocol === 'https:' && url.hostname === 'huggingface.co') {
    return {
      canonicalUrl: trimmed,
      path: decodedPathname,
      filename: decodedPathname.split('/').pop(),
      protocol: 'hf'
    }
  }

  throw new TypeError(
    `Unsupported source URL: ${trimmed}. Supported protocols: s3://, https://huggingface.co/`
  )
}

module.exports = {
  parseCanonicalSource
}
