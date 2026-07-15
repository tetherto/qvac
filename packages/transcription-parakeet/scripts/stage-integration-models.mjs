#!/usr/bin/env node
'use strict'

// Stage the transcription-parakeet integration test GGUFs declared in
// test/integration/models.manifest.json into ./models/ by copying each object
// from the QVAC S3 model registry (`aws s3 cp s3://$MODEL_S3_BUCKET/<s3Path>`).
//
// Why this exists:
//   The manifest is the single source of truth for BOTH the cache key
//   (.github/actions/cache-models hashes the manifest) AND the CI staging set.
//   Driving the `aws s3 cp` list from the manifest keeps the two in lockstep:
//   adding/removing a model is one edit, and it can never silently produce a
//   cache hit that skips a now-missing download.
//
//   Parakeet models live in S3 (not HuggingFace), so the cache-models `warm`
//   step (HTTP/HF downloader) is disabled for this package and this script does
//   the fetch instead. It runs only on a cache miss (gated in the workflow);
//   on a hit every file is already present and this is a fast verify no-op.
//
// Integrity: when a manifest entry pins bytes/sha256, a present file is verified
// (size first, then sha256) and re-copied on mismatch; a freshly copied file is
// verified and the step FAILS on mismatch. Unpinned entries only require a
// non-empty file (matches warm-models.mjs behaviour). Pin with
// scripts/generate-model-manifest.mjs.
//
// Usage:
//   MODEL_S3_BUCKET=my-bucket node scripts/stage-integration-models.mjs [--output <dir>]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(__dirname, '..', 'test', 'integration', 'models.manifest.json')
const DEFAULT_OUT_DIR = resolve(__dirname, '..', 'models')

function parseArgs (argv) {
  const args = { output: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output' || argv[i] === '-o') args.output = resolve(argv[++i])
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

// Mirrors warm-models.mjs verify ordering: cheap size check before the
// expensive hash. Returns { ok, reason }.
async function verify (filePath, entry) {
  if (entry.bytes != null) {
    const { size } = statSync(filePath)
    if (size !== entry.bytes) return { ok: false, reason: `size ${size} != ${entry.bytes}` }
  }
  if (entry.sha256 != null) {
    const actual = await sha256File(filePath)
    if (actual !== entry.sha256) return { ok: false, reason: `sha256 mismatch (${actual})` }
  }
  return { ok: true }
}

function s3Cp (bucket, s3Path, dest) {
  const uri = `s3://${bucket}/${s3Path}`
  console.log(`  > aws s3 cp ${uri}`)
  const res = spawnSync('aws', ['s3', 'cp', uri, dest], { stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`aws s3 cp exited ${res.status} for ${uri}`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  const bucket = process.env.MODEL_S3_BUCKET
  if (!bucket) throw new Error('MODEL_S3_BUCKET is not set')

  if (!existsSync(MANIFEST_PATH)) throw new Error(`missing manifest at ${MANIFEST_PATH}`)
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const entries = Object.entries(manifest.models || {})
  if (!entries.length) throw new Error('manifest has no models')

  mkdirSync(args.output, { recursive: true })
  console.log(`Staging ${entries.length} parakeet GGUF(s) from s3://${bucket} into ${args.output}`)

  let staged = 0
  let skipped = 0

  for (const [name, entry] of entries) {
    if (!entry.s3Path) throw new Error(`${name}: missing s3Path in manifest`)
    const dest = join(args.output, name)
    const hasIntegrity = entry.sha256 != null || entry.bytes != null

    if (existsSync(dest)) {
      if (hasIntegrity) {
        const res = await verify(dest, entry)
        if (res.ok) {
          console.log(`  ✓ ${name}: present + verified — skip`)
          skipped++
          continue
        }
        console.log(`  ! ${name}: present but failed integrity (${res.reason}) — re-staging`)
        rmSync(dest, { force: true })
      } else if (statSync(dest).size > 0) {
        console.log(`  ✓ ${name}: present (no sha256/bytes pinned — integrity check SKIPPED) — skip`)
        skipped++
        continue
      } else {
        rmSync(dest, { force: true })
      }
    }

    s3Cp(bucket, entry.s3Path, dest)

    if (!existsSync(dest) || statSync(dest).size < 1) {
      throw new Error(`${name}: staged file missing or empty after copy`)
    }
    if (hasIntegrity) {
      const res = await verify(dest, entry)
      if (!res.ok) {
        rmSync(dest, { force: true })
        throw new Error(`${name}: freshly staged file failed integrity: ${res.reason}`)
      }
    }
    const { size } = statSync(dest)
    console.log(`  ✓ ${name}: ready (${(size / 1024 / 1024).toFixed(1)}MB)`)
    staged++
  }

  console.log(`Done: ${staged} staged, ${skipped} already present`)
}

main().catch((err) => {
  console.error(err.stack || String(err))
  process.exit(1)
})
