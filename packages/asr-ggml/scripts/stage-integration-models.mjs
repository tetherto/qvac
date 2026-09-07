#!/usr/bin/env node
'use strict'

// Stage the parakeet-engine integration test GGUFs declared in
// test/integration/parakeet-models.manifest.json into ./models/ by copying each object
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
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = resolve(
  __dirname,
  '..',
  'test',
  'integration',
  'parakeet-models.manifest.json'
)
const DEFAULT_OUT_DIR = resolve(__dirname, '..', 'models')

// Core ML encoder sidecars are pinned in their own manifest rather than as a
// new key in parakeet-models.manifest.json: that manifest's guard test asserts
// an exact top-level key set, and both files are hashed into the model cache
// key by the same `*.manifest.json` glob, so a separate file costs nothing.
//
// Sidecars are optional. An absent manifest, or an empty `sidecars` object,
// leaves models/coreml/ unpopulated and the Core ML benchmark lanes skip
// themselves -- no other lane is affected.
const COREML_MANIFEST_PATH = resolve(
  __dirname,
  '..',
  'test',
  'integration',
  'parakeet-coreml.manifest.json'
)
const COREML_SUBDIR = 'coreml'

function parseArgs(argv) {
  const args = { output: DEFAULT_OUT_DIR, coremlOnly: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output' || argv[i] === '-o') args.output = resolve(argv[++i])
    // Sidecars are darwin-only content inside a model cache whose key carries
    // no OS, so the GGUF staging step's cache-hit gate cannot be trusted to
    // have populated them. This flag lets CI stage them in their own
    // always-run step without re-verifying multi-GB GGUFs.
    else if (argv[i] === '--coreml-only') args.coremlOnly = true
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return args
}

function sha256File(filePath) {
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
async function verify(filePath, entry) {
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

function s3Cp(bucket, s3Path, dest) {
  const uri = `s3://${bucket}/${s3Path}`
  console.log(`  > aws s3 cp ${uri}`)
  const res = spawnSync('aws', ['s3', 'cp', uri, dest], { stdio: 'inherit' })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`aws s3 cp exited ${res.status} for ${uri}`)
}

// Stage the zipped .mlmodelc bundles into <output>/coreml/ and unzip them.
// Deliberately non-fatal on absence and darwin-only: a Core ML sidecar is
// useless anywhere else, and no non-Apple lane should pay to download it.
async function stageCoremlSidecars(bucket, outputDir) {
  if (!existsSync(COREML_MANIFEST_PATH)) return
  if (process.platform !== 'darwin') {
    console.log('Core ML sidecars: not darwin — skip')
    return
  }

  const manifest = JSON.parse(readFileSync(COREML_MANIFEST_PATH, 'utf8'))
  const entries = Object.entries(manifest.sidecars || {})
  if (!entries.length) {
    console.log('Core ML sidecars: none pinned yet — Core ML benchmark lanes will skip')
    return
  }

  const coremlDir = join(outputDir, COREML_SUBDIR)
  mkdirSync(coremlDir, { recursive: true })
  console.log(`Staging ${entries.length} Core ML sidecar(s) into ${coremlDir}`)

  for (const [name, entry] of entries) {
    if (!entry.s3Path) throw new Error(`${name}: missing s3Path in Core ML manifest`)
    // `<stem>-encoder.mlmodelc.zip` unpacks to `<stem>-encoder.mlmodelc`, the
    // exact name parakeet.cpp derives from the GGUF path beside it.
    const bundleName = name.replace(/\.zip$/, '')
    const bundleDir = join(coremlDir, bundleName)
    const zipPath = join(coremlDir, name)

    // The extracted bundle is a directory, so it carries no hash of its own.
    // Stamp the pinned sha256 beside it: re-pinning a sidecar then restages it
    // instead of being masked by the stale bundle still sitting in the cache.
    const stampPath = join(coremlDir, `.${bundleName}.sha256`)
    if (existsSync(bundleDir)) {
      const stamped = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : ''
      if (stamped === entry.sha256) {
        console.log(`  OK ${bundleName}: present + pinned sha matches — skip`)
        continue
      }
      console.log(`  ! ${bundleName}: staged for a different pin — re-staging`)
      rmSync(bundleDir, { recursive: true, force: true })
      rmSync(stampPath, { force: true })
    }

    s3Cp(bucket, entry.s3Path, zipPath)

    const res = await verify(zipPath, entry)
    if (!res.ok) {
      rmSync(zipPath, { force: true })
      throw new Error(`${name}: staged sidecar failed integrity: ${res.reason}`)
    }

    const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', coremlDir], { stdio: 'inherit' })
    rmSync(zipPath, { force: true })
    if (unzip.error || unzip.status !== 0) {
      // Never leave a half-extracted bundle behind: without the stamp it would
      // be re-staged anyway, but a partial .mlmodelc that the engine tries to
      // load is worse than none at all.
      rmSync(bundleDir, { recursive: true, force: true })
      throw unzip.error || new Error(`unzip exited ${unzip.status} for ${name}`)
    }

    if (!existsSync(bundleDir)) {
      throw new Error(`${name}: expected ${bundleName} after unzip`)
    }
    // Stamp last, so it can only ever describe a fully extracted bundle.
    writeFileSync(stampPath, `${entry.sha256}\n`)
    console.log(`  OK ${bundleName}: ready`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const bucket = process.env.MODEL_S3_BUCKET
  if (!bucket) throw new Error('MODEL_S3_BUCKET is not set')

  if (args.coremlOnly) {
    await stageCoremlSidecars(bucket, args.output)
    return
  }

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
          console.log(`  OK ${name}: present + verified — skip`)
          skipped++
          continue
        }
        console.log(`  ! ${name}: present but failed integrity (${res.reason}) — re-staging`)
        rmSync(dest, { force: true })
      } else if (statSync(dest).size > 0) {
        console.log(
          `  OK ${name}: present (no sha256/bytes pinned — integrity check SKIPPED) — skip`
        )
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
    console.log(`  OK ${name}: ready (${(size / 1024 / 1024).toFixed(1)}MB)`)
    staged++
  }

  await stageCoremlSidecars(bucket, args.output)

  console.log(`Done: ${staged} staged, ${skipped} already present`)
}

main().catch((err) => {
  console.error(err.stack || String(err))
  process.exit(1)
})
