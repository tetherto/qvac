#!/usr/bin/env node
'use strict'

// Pin `bytes` + `sha256` in test/integration/models.manifest.json from files
// already staged in ./models/ (e.g. after scripts/stage-integration-models.mjs
// or `npm run download-models:registry`). Network-free: it only hashes local
// files, so it is safe to run in CI right after the S3 staging step.
//
// Entries whose local file is absent are left untouched (null stays null).
// Existing pinned values are overwritten with the freshly computed ones so a
// re-pin after a model refresh is idempotent.
//
// Usage:
//   node scripts/generate-model-manifest.mjs [--models <dir>] [--check]
//
//   --check  Do not write; exit non-zero if any locally-present file disagrees
//            with the pinned bytes/sha256 (useful as a CI drift guard).

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(__dirname, '..', 'test', 'integration', 'models.manifest.json')
const DEFAULT_MODELS_DIR = resolve(__dirname, '..', 'models')

function parseArgs (argv) {
  const args = { models: DEFAULT_MODELS_DIR, check: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--models' || argv[i] === '-m') args.models = resolve(argv[++i])
    else if (argv[i] === '--check') args.check = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return args
}

function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const entries = Object.entries(manifest.models || {})

  let pinned = 0
  let missing = 0
  const drift = []

  for (const [name, entry] of entries) {
    const file = join(args.models, name)
    if (!existsSync(file)) {
      console.log(`  - ${name}: not present locally — leaving ${entry.bytes == null ? 'unpinned' : 'as-is'}`)
      missing++
      continue
    }
    const bytes = statSync(file).size
    const sha256 = await sha256File(file)

    if (args.check) {
      if (entry.bytes == null) drift.push(`${name}: bytes is not pinned`)
      else if (entry.bytes !== bytes) drift.push(`${name}: bytes ${entry.bytes} != ${bytes}`)
      if (entry.sha256 == null) drift.push(`${name}: sha256 is not pinned`)
      else if (entry.sha256 !== sha256) drift.push(`${name}: sha256 ${entry.sha256} != ${sha256}`)
      continue
    }

    entry.bytes = bytes
    entry.sha256 = sha256
    console.log(`  ✓ ${name}: bytes=${bytes} sha256=${sha256}`)
    pinned++
  }

  if (args.check) {
    if (drift.length) {
      console.error(`Manifest drift detected:\n  ${drift.join('\n  ')}`)
      process.exit(1)
    }
    console.log('Manifest matches locally-present files.')
    return
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Wrote ${MANIFEST_PATH}: ${pinned} pinned, ${missing} left unpinned`)
}

main().catch((err) => {
  console.error(err.stack || String(err))
  process.exit(1)
})
