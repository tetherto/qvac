#!/usr/bin/env node
'use strict'

// Populates sha256 + bytes in test/integration/models.manifest.json by
// downloading each pinned URL FRESH into a temp directory and hashing it.
//
// IMPORTANT (integrity provenance): shas are computed from a clean download of
// the pinned URL, never from packages/embed-llamacpp/test/model (which may be a
// stale or poisoned restored cache). Run this on a machine/CI with network and
// an HF_TOKEN for gated repos.
//
// Usage:
//   HF_TOKEN=hf_xxx node scripts/generate-model-manifest.mjs [--only <modelName>] [--force]
//
// Flags:
//   --only <name>   Only (re)generate the named model entry.
//   --force         Recompute even entries that already have a sha256.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(__dirname, '../test/integration/models.manifest.json')
const HUGGING_FACE_HOSTNAME = 'huggingface.co'
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s"'<>]+/gi
const MODEL_ARTIFACT_PATH_PATTERN = /\.gguf$/i

export class CanonicalMetadataError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'CanonicalMetadataError'
  }
}

export function parseArgs(argv) {
  const args = { only: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function parseHttpsUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError('invalid URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new TypeError(`unsupported URL protocol: ${parsed.protocol}`)
  }

  return parsed
}

export function isTrustedHuggingFaceUrl(url) {
  return parseHttpsUrl(url).hostname === HUGGING_FACE_HOSTNAME
}

export function redactUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return '[redacted URL]'
  }

  parsed.username = ''
  parsed.password = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

function redactUrlsInText(value) {
  return String(value).replace(URL_IN_TEXT_PATTERN, (url) => redactUrl(url))
}

function sanitizedError(err) {
  const message = redactUrlsInText(err instanceof Error ? err.message : err)
  const cause = err instanceof Error ? err.cause : undefined
  const safeCause = cause === undefined ? undefined : sanitizedError(cause)
  const stackContainsSecrets =
    err instanceof Error &&
    typeof err.stack === 'string' &&
    redactUrlsInText(err.stack) !== err.stack
  const hasUnsafeProperties =
    err instanceof Error && Object.keys(err).some((key) => key !== 'name' && key !== 'cause')

  if (
    err instanceof Error &&
    message === err.message &&
    safeCause === cause &&
    !stackContainsSecrets &&
    !hasUnsafeProperties
  ) {
    return err
  }

  const options = safeCause === undefined ? undefined : { cause: safeCause }
  if (err instanceof CanonicalMetadataError) {
    return new CanonicalMetadataError(message, options)
  }
  return new Error(message, options)
}

export function authHeaders(url, token = process.env.HF_TOKEN) {
  const parsed = parseHttpsUrl(url)
  const headers = { 'user-agent': 'qvac-manifest-generator' }
  if (isTrustedHuggingFaceUrl(parsed) && token) {
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

function getHeader(headers, name) {
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === name) return value
  }
  return undefined
}

function parseCanonicalLfsMetadata(headers, sourceUrl, required) {
  const rawSha256 = getHeader(headers, 'x-linked-etag')
  const rawBytes = getHeader(headers, 'x-linked-size')
  const hasSha256 = rawSha256 !== undefined
  const hasBytes = rawBytes !== undefined

  if (!required && !hasSha256 && !hasBytes) return null
  if (!hasSha256 || !hasBytes) {
    throw new CanonicalMetadataError(
      `incomplete Hugging Face LFS metadata for ${redactUrl(sourceUrl)}`
    )
  }
  if (typeof rawSha256 !== 'string' || typeof rawBytes !== 'string') {
    throw new CanonicalMetadataError(
      `invalid Hugging Face LFS metadata for ${redactUrl(sourceUrl)}`
    )
  }

  const shaMatch = rawSha256.match(/^"?([a-f0-9]{64})"?$/i)
  const bytes = Number(rawBytes)
  if (!shaMatch || !/^\d+$/.test(rawBytes) || !Number.isSafeInteger(bytes)) {
    throw new CanonicalMetadataError(
      `invalid Hugging Face LFS metadata for ${redactUrl(sourceUrl)}`
    )
  }

  return { sha256: shaMatch[1].toLowerCase(), bytes }
}

function canonicalMetadataFromResponse(sourceUrl, redirectUrl, headers) {
  if (!isTrustedHuggingFaceUrl(sourceUrl)) return null

  const isResolveUrl = sourceUrl.pathname.split('/').includes('resolve')
  const isModelArtifact = MODEL_ARTIFACT_PATH_PATTERN.test(sourceUrl.pathname)
  const redirectsOffHost = redirectUrl !== null && !isTrustedHuggingFaceUrl(redirectUrl)

  return parseCanonicalLfsMetadata(
    headers,
    sourceUrl,
    isModelArtifact || (isResolveUrl && redirectsOffHost)
  )
}

function mergeCanonicalMetadata(current, next, sourceUrl) {
  if (!current) return next
  if (!next) return current
  if (current.sha256 !== next.sha256 || current.bytes !== next.bytes) {
    throw new CanonicalMetadataError(
      `conflicting Hugging Face LFS metadata for ${redactUrl(sourceUrl)}`
    )
  }
  return current
}

function redirectUrl(location, sourceUrl) {
  if (typeof location !== 'string' || location.length === 0) {
    throw new TypeError(`redirect missing location for ${redactUrl(sourceUrl)}`)
  }

  try {
    return parseHttpsUrl(new URL(location, sourceUrl))
  } catch {
    throw new TypeError(`invalid redirect URL from ${redactUrl(sourceUrl)}`)
  }
}

function discardResponse(res) {
  if (res.destroyed || res.readableEnded) return
  try {
    if (typeof res.resume === 'function') res.resume()
    else if (typeof res.destroy === 'function') res.destroy()
  } catch {
    try {
      if (typeof res.destroy === 'function') res.destroy()
    } catch {}
  }
}

function downloadWithRedirects(url, dest, { redirectsLeft, token, request }, canonicalMetadata) {
  return new Promise((resolve, reject) => {
    const sourceUrl = parseHttpsUrl(url)
    let req
    try {
      req = request(sourceUrl, { headers: authHeaders(sourceUrl, token) }, (res) => {
        async function handleResponse() {
          try {
            if (REDIRECT_STATUS_CODES.has(res.statusCode)) {
              if (redirectsLeft <= 0) {
                throw new Error(`too many redirects: ${redactUrl(sourceUrl)}`)
              }

              const nextUrl = redirectUrl(res.headers.location, sourceUrl)
              const responseMetadata = canonicalMetadataFromResponse(
                sourceUrl,
                nextUrl,
                res.headers
              )
              const nextMetadata = mergeCanonicalMetadata(
                canonicalMetadata,
                responseMetadata,
                sourceUrl
              )
              discardResponse(res)
              return downloadWithRedirects(
                nextUrl,
                dest,
                {
                  redirectsLeft: redirectsLeft - 1,
                  token,
                  request
                },
                nextMetadata
              )
            }

            if (res.statusCode !== 200) {
              throw new Error(`HTTP ${res.statusCode} for ${redactUrl(sourceUrl)}`)
            }

            const responseMetadata = canonicalMetadataFromResponse(sourceUrl, null, res.headers)
            const finalMetadata = mergeCanonicalMetadata(
              canonicalMetadata,
              responseMetadata,
              sourceUrl
            )
            await pipeline(res, createWriteStream(dest))
            return finalMetadata
          } catch (err) {
            discardResponse(res)
            throw sanitizedError(err)
          }
        }

        handleResponse().then(resolve).catch(reject)
      })
    } catch (err) {
      reject(sanitizedError(err))
      return
    }
    req.on('error', (err) => reject(sanitizedError(err)))
  })
}

export function download(
  url,
  dest,
  { redirectsLeft = 10, token = process.env.HF_TOKEN, request = https.get } = {}
) {
  return downloadWithRedirects(url, dest, { redirectsLeft, token, request }, null)
}

// Hash is streamed because fs.readFile is hard-capped at 2 GiB
// (kIoMaxLength) and most of these model files are larger than that.
export function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function sha256AndSize(filePath) {
  const sha256 = await sha256Stream(filePath)
  const { size } = await stat(filePath)
  return { sha256, bytes: size }
}

export function verifyCanonicalMetadata(actual, canonical, sourceUrl) {
  if (!canonical) return
  if (actual.sha256 !== canonical.sha256) {
    throw new CanonicalMetadataError(
      `SHA-256 mismatch for ${redactUrl(sourceUrl)}: expected ${canonical.sha256}, got ${actual.sha256}`
    )
  }
  if (actual.bytes !== canonical.bytes) {
    throw new CanonicalMetadataError(
      `size mismatch for ${redactUrl(sourceUrl)}: expected ${canonical.bytes}, got ${actual.bytes}`
    )
  }
}

export async function generateModelPin(
  name,
  entry,
  tmp,
  { downloadFile = download, hashFile = sha256AndSize, removeFile = rm, logger = console } = {}
) {
  let lastErr

  for (const url of entry.urls) {
    const dest = join(tmp, name)
    try {
      logger.log(`downloading ${name} from ${parseHttpsUrl(url).host} ...`)
      const canonicalMetadata = await downloadFile(url, dest)
      const candidate = await hashFile(dest)
      verifyCanonicalMetadata(candidate, canonicalMetadata, url)
      logger.log(`  -> sha256 ${candidate.sha256} (${candidate.bytes} bytes)`)
      return candidate
    } catch (err) {
      const safeErr = sanitizedError(err)
      lastErr = safeErr
      logger.log(`  ! ${safeErr.message}`)
      if (safeErr instanceof CanonicalMetadataError) throw safeErr
    } finally {
      await removeFile(dest, { force: true })
    }
  }

  throw new Error(`failed to fetch ${name}: ${lastErr && lastErr.message}`, {
    cause: lastErr
  })
}

export async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const tmp = await mkdtemp(join(tmpdir(), 'qvac-manifest-'))
  let updated = 0

  try {
    for (const [name, entry] of Object.entries(manifest.models)) {
      if (args.only && args.only !== name) continue
      if (entry.sha256 && !args.force) {
        console.log(`skip ${name} (already pinned; use --force to recompute)`)
        continue
      }

      const result = await generateModelPin(name, entry, tmp)
      entry.sha256 = result.sha256
      entry.bytes = result.bytes
      updated++
    }

    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`\nUpdated ${updated} model entr${updated === 1 ? 'y' : 'ies'} in ${MANIFEST_PATH}`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
