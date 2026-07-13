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

function authHeaders(url) {
  const headers = { 'user-agent': 'qvac-manifest-generator' }
  if (url.includes('huggingface.co') && process.env.HF_TOKEN) {
    headers.authorization = `Bearer ${process.env.HF_TOKEN}`
  }
  return headers
}

function download(url, dest, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: authHeaders(url) }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects: ${url}`))
        res.resume()
        const next = new URL(res.headers.location, url).href
        return resolve(download(next, dest, redirectsLeft - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      pipeline(res, createWriteStream(dest)).then(resolve).catch(reject)
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
          console.log(`downloading ${name} from ${new URL(url).host} ...`)
          await download(url, dest)
          result = await sha256AndSize(dest)
          await rm(dest, { force: true })
          console.log(`  -> sha256 ${result.sha256} (${result.bytes} bytes)`)
          break
        } catch (err) {
          lastErr = err
          console.log(`  ! ${err.message}`)
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
