#!/usr/bin/env node
'use strict'

// Stage the whisper-engine integration test models declared in
// test/integration/whisper-models.manifest.json into ./models/.
//
// Why this exists:
//   packages/asr-ggml/models is ONE cache entry covering BOTH engines. The
//   parakeet GGUFs come from S3 (stage-integration-models.mjs); the whisper
//   model and the VAD model are pulled from HuggingFace by the tests
//   themselves, at test runtime, via test/integration/helpers.js.
//
//   That was fine while nothing pre-populated the entry: a same-repo PR's first
//   run downloaded them and the post-job save captured the whole directory, so
//   its next run was warm. Once on-merge-model-cache-asr.yml seeds the entry,
//   every PR leg gets an EXACT primary-key hit, actions/cache skips its save by
//   design, and the entry can never grow to include them -- so all seven legs
//   would re-fetch ~78 MB from HuggingFace on every run, forever. Seeding them
//   here keeps the entry complete.
//
//   cache-models' own `warm` step cannot do this: warm-models.mjs reads
//   packages/<pkg>/test/integration/models.manifest.json and writes to
//   packages/<pkg>/test/model, and asr-ggml uses neither path.
//
// Revisions are pinned. `resolve/main` would let the bytes behind an unchanged
// cache key change under us; bumping a revision here changes the manifest,
// which changes the cache key (cache-models hashes test/integration/*.manifest.json),
// which re-seeds. That is the intended behaviour.
//
// Integrity: size first, then sha256. A present file that fails either is
// re-downloaded; a freshly downloaded file that fails either FAILS the step.
//
// Node built-ins only, so it runs on every seed platform without an install.
//
// Usage:
//   node scripts/stage-whisper-models.mjs [--output <dir>]

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(
  __dirname,
  '..',
  'test',
  'integration',
  'whisper-models.manifest.json'
)
const DEFAULT_OUT_DIR = resolve(__dirname, '..', 'models')
const MAX_ATTEMPTS = 3

function parseArgs(argv) {
  const i = argv.indexOf('--output')
  return { outDir: i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : DEFAULT_OUT_DIR }
}

function sha256File(filePath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', rej)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => res(hash.digest('hex')))
  })
}

// Returns null when the file is good, or a human-readable reason when it is not.
async function inspect(filePath, { sha256, bytes }) {
  if (!existsSync(filePath)) return 'missing'
  const size = statSync(filePath).size
  if (bytes && size !== bytes) return `size ${size}, expected ${bytes}`
  if (!bytes && size === 0) return 'empty'
  if (sha256) {
    const actual = await sha256File(filePath)
    if (actual !== sha256) return `sha256 ${actual}, expected ${sha256}`
  }
  return null
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${new URL(url).host}`)
  // Buffered, not streamed: the largest of these is 78 MB, and a whole-file
  // write means a failed attempt can never leave a half-written file that the
  // next run would have to distinguish from a good one.
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const models = manifest.models || {}
  const names = Object.keys(models)
  if (names.length === 0) throw new Error(`No models declared in ${MANIFEST_PATH}`)

  mkdirSync(outDir, { recursive: true })
  console.log(`[whisper] staging ${names.length} model(s) into ${outDir}`)

  let downloaded = 0
  let reused = 0
  for (const name of names) {
    const entry = models[name]
    const dest = join(outDir, name)

    const existing = await inspect(dest, entry)
    if (existing === null) {
      console.log(`[whisper] ${name}: already present and verified`)
      reused++
      continue
    }
    if (existsSync(dest)) {
      console.log(`[whisper] ${name}: discarding (${existing})`)
      rmSync(dest, { force: true })
    }

    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
    let lastErr
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const url = urls[(attempt - 1) % urls.length]
      try {
        console.log(`[whisper] ${name}: downloading (attempt ${attempt}/${MAX_ATTEMPTS})`)
        await download(url, dest)
        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
        rmSync(dest, { force: true })
        console.log(`[whisper] ${name}: attempt ${attempt} failed — ${err.message}`)
      }
    }
    if (lastErr) {
      throw new Error(
        `${name}: download failed after ${MAX_ATTEMPTS} attempts — ${lastErr.message}`
      )
    }

    const bad = await inspect(dest, entry)
    if (bad !== null) {
      rmSync(dest, { force: true })
      throw new Error(`${name}: integrity check failed after download — ${bad}`)
    }
    console.log(`[whisper] ${name}: verified (${statSync(dest).size} bytes)`)
    downloaded++
  }

  console.log(`[whisper] summary: downloaded=${downloaded} reused=${reused} total=${names.length}`)
}

main().catch((err) => {
  console.error(`[whisper] ${err.message}`)
  process.exit(1)
})
