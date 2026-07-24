#!/usr/bin/env node
'use strict'

// Populates sha256 + bytes in test/integration/models.manifest.json by
// downloading each pinned URL FRESH into a temp directory and hashing it.
//
// IMPORTANT (integrity provenance): shas are computed from a clean download of
// the pinned URL, never from packages/diffusion-cpp/test/model (which may be a
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

function parseArgs(argv) {
  const args = { only: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i]
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

export function isHuggingFaceUrl(url) {
  const parsed = new URL(url)
  return parsed.protocol === 'https:' && parsed.hostname === 'huggingface.co'
}

export function isHuggingFaceLfsUrl(url) {
  const parsed = new URL(url)
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'huggingface.co' &&
    parsed.pathname.includes('/resolve/')
  )
}

export function isImmutableHuggingFaceLfsUrl(url) {
  if (!isHuggingFaceLfsUrl(url)) return false
  const parsed = new URL(url)
  return (
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    !parsed.search &&
    !parsed.hash &&
    /^\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/.+/i.test(parsed.pathname)
  )
}

export function authHeaders(url, token = process.env.HF_TOKEN) {
  const headers = { 'user-agent': 'qvac-manifest-generator' }
  if (isHuggingFaceUrl(url) && token) {
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

export function redactUrl(url) {
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

export function redactUrlsInText(value) {
  return String(value).replace(/https?:\/\/[^\s]+/gi, (url) => redactUrl(url))
}

export function linkedIntegrity(headers) {
  const rawEtag = headers['x-linked-etag']
  const etag = typeof rawEtag === 'string' ? rawEtag.replace(/^W\//, '').replace(/"/g, '') : ''
  const rawSize = Number(headers['x-linked-size'])
  return {
    sha256: /^[0-9a-f]{64}$/i.test(etag) ? etag.toLowerCase() : undefined,
    bytes: Number.isInteger(rawSize) && rawSize > 0 ? rawSize : undefined
  }
}

export function canonicalIntegrity(url, headers, inherited = {}) {
  if (!isHuggingFaceLfsUrl(url)) return inherited

  const observed = linkedIntegrity(headers)
  for (const field of ['sha256', 'bytes']) {
    if (
      inherited[field] !== undefined &&
      observed[field] !== undefined &&
      inherited[field] !== observed[field]
    ) {
      throw new Error(`conflicting canonical Hugging Face LFS ${field} metadata`)
    }
  }
  return {
    sha256: inherited.sha256 ?? observed.sha256,
    bytes: inherited.bytes ?? observed.bytes
  }
}

function discardResponse(res) {
  try {
    res.resume()
  } catch (_) {
    if (typeof res.destroy === 'function') res.destroy()
  }
}

export function download(
  url,
  dest,
  {
    redirectsLeft = 10,
    expected = {},
    requireCanonicalMetadata = isHuggingFaceLfsUrl(url),
    requester = https
  } = {}
) {
  return new Promise((resolvePromise, reject) => {
    let req
    try {
      req = requester.get(url, { headers: authHeaders(url) }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) {
            discardResponse(res)
            return reject(new Error(`too many redirects: ${redactUrl(url)}`))
          }
          let sourceIntegrity
          let next
          try {
            sourceIntegrity = canonicalIntegrity(url, res.headers, expected)
            next = new URL(res.headers.location, url).href
          } catch (err) {
            discardResponse(res)
            return reject(new Error(redactUrlsInText(err.message)))
          }
          discardResponse(res)
          return resolvePromise(
            download(next, dest, {
              redirectsLeft: redirectsLeft - 1,
              expected: sourceIntegrity,
              requireCanonicalMetadata: requireCanonicalMetadata || isHuggingFaceLfsUrl(next),
              requester
            })
          )
        }
        if (res.statusCode !== 200) {
          discardResponse(res)
          return reject(new Error(`HTTP ${res.statusCode} for ${redactUrl(url)}`))
        }

        let sourceIntegrity
        try {
          sourceIntegrity = canonicalIntegrity(url, res.headers, expected)
        } catch (err) {
          discardResponse(res)
          return reject(new Error(redactUrlsInText(err.message)))
        }
        if (requireCanonicalMetadata && (!sourceIntegrity.sha256 || !sourceIntegrity.bytes)) {
          discardResponse(res)
          return reject(
            new Error(
              `missing canonical Hugging Face LFS SHA-256/size metadata for ${redactUrl(url)}`
            )
          )
        }
        pipeline(res, createWriteStream(dest))
          .then(() => resolvePromise(sourceIntegrity))
          .catch((err) => reject(new Error(redactUrlsInText(err.message))))
      })
    } catch (err) {
      return reject(new Error(redactUrlsInText(err.message)))
    }
    req.on('error', (err) => reject(new Error(redactUrlsInText(err.message))))
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

export async function sha256AndSize(filePath) {
  const sha256 = await sha256Stream(filePath)
  const { size } = await stat(filePath)
  return { sha256, bytes: size }
}

// Every Hugging Face artifact must satisfy `downloaded SHA/size == canonical
// content address`. There is no source-mismatch exception: a source whose
// delivered bytes disagree with its own immutable content address (e.g. a
// legacy-LFS blob whose bytes do not match its pointer OID) is not auditable
// and must be replaced, not documented.
export function validateDownloadedIntegrity({ expected, candidate }) {
  if (expected.sha256 && candidate.sha256 !== expected.sha256) {
    throw new Error(
      `downloaded SHA-256 ${candidate.sha256} does not match source LFS OID ${expected.sha256}`
    )
  }
  if (expected.bytes && candidate.bytes !== expected.bytes) {
    throw new Error(
      `downloaded size ${candidate.bytes} does not match source size ${expected.bytes}`
    )
  }
}

export async function fetchModelResult(
  name,
  entry,
  tmp,
  { downloadFile = download, inspectFile = sha256AndSize } = {}
) {
  let lastErr

  for (const url of entry.urls) {
    const dest = join(tmp, name)
    try {
      await rm(dest, { force: true })
      console.log(`downloading ${name} from ${new URL(url).host} ...`)
      const expected = await downloadFile(url, dest)
      const candidate = await inspectFile(dest)
      validateDownloadedIntegrity({ url, entry, expected, candidate })
      console.log(`  -> sha256 ${candidate.sha256} (${candidate.bytes} bytes)`)
      return candidate
    } catch (err) {
      lastErr = new Error(redactUrlsInText(err.message))
      console.log(`  ! ${lastErr.message}`)
    } finally {
      await rm(dest, { force: true })
    }
  }

  throw new Error(`failed to fetch ${name}: ${lastErr && lastErr.message}`)
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

      const result = await fetchModelResult(name, entry, tmp)
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
    console.error(redactUrlsInText(err.stack || String(err)))
    process.exit(1)
  })
}
