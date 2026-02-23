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
    const bucket = url.hostname || null
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

/**
 * Resolve the S3 bucket for a parsed source.
 * If the source already contains a bucket, returns as-is.
 * Otherwise injects the bucket from the provided value.
 * @param {object} sourceInfo - Result from parseCanonicalSource
 * @param {string} bucket - Bucket name to inject when source has none
 * @returns {object} sourceInfo with resolved bucket
 */
function resolveS3Bucket (sourceInfo, bucket) {
  if (sourceInfo.protocol !== 's3') return sourceInfo
  if (sourceInfo.bucket) return sourceInfo

  if (!bucket) {
    throw new Error(
      'QVAC_S3_BUCKET is not set. S3 source URLs require a bucket name. Set QVAC_S3_BUCKET in .env or environment.'
    )
  }

  return {
    ...sourceInfo,
    bucket,
    canonicalUrl: `s3://${bucket}/${sourceInfo.key}`
  }
}

module.exports = {
  parseCanonicalSource,
  resolveS3Bucket
}
