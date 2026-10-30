#!/usr/bin/env node
'use strict'

// Stage every models.manifest.json entry that declares an `s3Path` (and no HF
// `urls`) into test/model by copying it from the QVAC model registry bucket.
// Present files that pass the sha256 pin are left alone; a fresh copy that
// fails it fails the step.
//
// Usage:
//   MODEL_S3_BUCKET=my-bucket node scripts/stage-s3-models.mjs [--output <dir>]

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { downloadFile } = require('./download-unit-test-models.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(__dirname, '..', 'test', 'integration', 'models.manifest.json')
const DEFAULT_OUT_DIR = resolve(__dirname, '..', 'test', 'model')

export function s3StagedEntries(manifest) {
  return Object.entries(manifest.models || {}).filter(
    ([, entry]) =>
      typeof entry.s3Path === 'string' &&
      entry.s3Path.length > 0 &&
      !(Array.isArray(entry.urls) && entry.urls.length > 0)
  )
}

function parseArgs(argv) {
  const args = { output: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output' || argv[i] === '-o') args.output = resolve(argv[++i])
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const entries = s3StagedEntries(manifest)
  if (entries.length === 0) {
    console.log('[stage-s3] no S3-staged models in the manifest')
    return
  }

  for (const [name, entry] of entries) {
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      throw new Error(`[stage-s3] ${name}: manifest entry has no valid sha256 pin`)
    }
    await downloadFile(undefined, join(args.output, name), {
      sha256: entry.sha256.toLowerCase(),
      s3Path: entry.s3Path
    })
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
