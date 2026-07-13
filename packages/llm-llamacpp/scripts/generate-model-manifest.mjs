#!/usr/bin/env node
'use strict'

// Populates sha256 + bytes in test/integration/models.manifest.json by
// downloading each pinned URL FRESH into a temp directory and hashing it.
//
// NOTE: this is distinct from scripts/generate-model-manifest.js, which builds
// the Android mobile pre-stage manifest (test/mobile/model-manifest.json).
//
// IMPORTANT (integrity provenance): shas are computed from a clean download of
// the pinned URL, never from packages/llm-llamacpp/test/model (which may be a
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
const HUGGING_FACE_HOST = 'huggingface.co'
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i

function parseArgs(argv) {
  const args = { only: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function isTrustedHuggingFaceUrl(url) {
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && parsed.hostname === HUGGING_FACE_HOST
}

function redactUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch (_) {
    return '[invalid URL]'
  }
}

function redactedErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https?:\/\/\S+/gi, (url) => redactUrl(url))
}

function authHeaders(url, token = process.env.HF_TOKEN) {
  const headers = { 'user-agent': 'qvac-manifest-generator' }
  if (isTrustedHuggingFaceUrl(url) && token) {
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

function redirectRequest(location, currentUrl, token = process.env.HF_TOKEN) {
  const url = new URL(location, currentUrl).href
  return { url, headers: authHeaders(url, token) }
}

function headerValue(headers, name) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function immutableHuggingFaceRevision(url) {
  if (!isTrustedHuggingFaceUrl(url)) return null
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  const revision = parts[2] === 'resolve' ? parts[3] : null
  if (!revision || !COMMIT_PATTERN.test(revision)) {
    throw new Error(`Hugging Face URL is not pinned to an immutable commit: ${redactUrl(url)}`)
  }
  return revision
}

function requiresHuggingFaceLfsMetadata(url) {
  // Every Hugging Face artifact in this manifest is LFS-backed except the
  // sharded-model tensors index, which is a regular Git blob.
  return (
    isTrustedHuggingFaceUrl(url) && !new URL(url).pathname.toLowerCase().endsWith('.tensors.txt')
  )
}

function parseHuggingFaceLfsMetadata(url, headers) {
  if (!isTrustedHuggingFaceUrl(url)) return null

  const revision = immutableHuggingFaceRevision(url)
  if (!requiresHuggingFaceLfsMetadata(url)) return null

  const repoCommit = headerValue(headers, 'x-repo-commit')
  if (!repoCommit || !COMMIT_PATTERN.test(repoCommit)) {
    throw new Error(
      `missing required Hugging Face LFS metadata: x-repo-commit for ${redactUrl(url)}`
    )
  }
  if (repoCommit.toLowerCase() !== revision.toLowerCase()) {
    throw new Error(
      `Hugging Face repository commit mismatch for ${redactUrl(url)}: ` +
        `expected ${revision}, got ${repoCommit}`
    )
  }

  const rawSha256 = headerValue(headers, 'x-linked-etag')
  const sha256 =
    typeof rawSha256 === 'string'
      ? rawSha256
          .replace(/^W\//, '')
          .replace(/^"|"$/g, '')
          .replace(/^sha256:/, '')
      : ''
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(
      `missing required Hugging Face LFS metadata: x-linked-etag for ${redactUrl(url)}`
    )
  }

  const rawBytes = headerValue(headers, 'x-linked-size')
  const bytes = Number(rawBytes)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      `missing required Hugging Face LFS metadata: x-linked-size for ${redactUrl(url)}`
    )
  }

  return { sha256: sha256.toLowerCase(), bytes, repoCommit: repoCommit.toLowerCase() }
}

function mergeLfsMetadata(current, next, url) {
  if (!current) return next
  if (!next) return current
  if (current.sha256 !== next.sha256 || current.bytes !== next.bytes) {
    throw new Error(`Hugging Face LFS metadata changed across redirects for ${redactUrl(url)}`)
  }
  return current
}

function metadataAfterResponse(current, responseUrl, headers) {
  const canonicalMetadata = parseHuggingFaceLfsMetadata(responseUrl, headers)
  return mergeLfsMetadata(current, canonicalMetadata, responseUrl)
}

function verifyDownloadAgainstLfs(url, result, lfsMetadata) {
  if (!requiresHuggingFaceLfsMetadata(url)) return
  if (!lfsMetadata) {
    throw new Error(`missing required Hugging Face LFS metadata for ${redactUrl(url)}`)
  }
  if (result.sha256.toLowerCase() !== lfsMetadata.sha256) {
    throw new Error(
      `Hugging Face LFS SHA-256 mismatch for ${redactUrl(url)}: ` +
        `expected ${lfsMetadata.sha256}, got ${result.sha256}`
    )
  }
  if (result.bytes !== lfsMetadata.bytes) {
    throw new Error(
      `Hugging Face LFS size mismatch for ${redactUrl(url)}: ` +
        `expected ${lfsMetadata.bytes}, got ${result.bytes}`
    )
  }
}

function download(
  url,
  dest,
  { redirectsLeft = 10, lfsMetadata = null, token = process.env.HF_TOKEN } = {}
) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: authHeaders(url, token) }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirectsLeft <= 0) {
          return reject(new Error(`too many redirects: ${redactUrl(url)}`))
        }
        res.resume()
        try {
          const nextMetadata = metadataAfterResponse(lfsMetadata, url, res.headers)
          const next = redirectRequest(res.headers.location, url, token)
          return resolve(
            download(next.url, dest, {
              redirectsLeft: redirectsLeft - 1,
              lfsMetadata: nextMetadata,
              token
            })
          )
        } catch (err) {
          return reject(err)
        }
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${redactUrl(url)}`))
      }

      let nextMetadata
      try {
        nextMetadata = metadataAfterResponse(lfsMetadata, url, res.headers)
      } catch (err) {
        res.resume()
        return reject(err)
      }
      pipeline(res, createWriteStream(dest))
        .then(() => resolve({ lfsMetadata: nextMetadata }))
        .catch(reject)
    })
    req.on('error', reject)
  })
}

// Hash is streamed because fs.readFile is hard-capped at 2 GiB
// (kIoMaxLength) and most of these model files are larger than that.
function sha256Stream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function sha256AndSize(filePath) {
  const sha256 = await sha256Stream(filePath)
  const { size } = await stat(filePath)
  return { sha256, bytes: size }
}

async function main() {
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

      let lastErr
      let result
      for (const url of entry.urls) {
        const dest = join(tmp, name)
        try {
          console.log(`downloading ${name} from ${new URL(url).hostname} ...`)
          const { lfsMetadata } = await download(url, dest)
          const candidate = await sha256AndSize(dest)
          verifyDownloadAgainstLfs(url, candidate, lfsMetadata)
          await rm(dest, { force: true })
          result = candidate
          console.log(`  -> sha256 ${candidate.sha256} (${candidate.bytes} bytes)`)
          break
        } catch (err) {
          await rm(dest, { force: true })
          const message = redactedErrorMessage(err)
          lastErr = new Error(message)
          console.log(`  ! ${message}`)
        }
      }

      if (!result) throw new Error(`failed to fetch ${name}: ${lastErr && lastErr.message}`)
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(redactedErrorMessage(err))
    process.exit(1)
  })
}

export {
  authHeaders,
  immutableHuggingFaceRevision,
  isTrustedHuggingFaceUrl,
  metadataAfterResponse,
  parseHuggingFaceLfsMetadata,
  redactUrl,
  redactedErrorMessage,
  redirectRequest,
  requiresHuggingFaceLfsMetadata,
  verifyDownloadAgainstLfs
}
