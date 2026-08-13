'use strict'
// Seed-if-missing + presign for mobile e2e model sourcing (QVAC-23466 pilot).
//
// HuggingFace-bound mobile addons (llm-llamacpp, diffusion-cpp) fetch their
// models from huggingface.co, which is cross-region + flaky for the us-west-2
// Device Farm fleet. This script mirrors exactly the models a run needs into the
// Device-Farm-local US bucket ONCE (idempotent: an already-seeded object is a
// no-op), then presigns each object so the run can pull it from the same region.
//
// It reads the addon's pinned integration manifest (the single source of truth
// for URLs + sha256/bytes), and for each model:
//   1. HEADs s3://<bucket>/<prefix><name>; if present with the pinned size it is
//      left untouched (already seeded).
//   2. Otherwise downloads from the manifest URL(s) (HF gets a bearer token; the
//      token is never forwarded across a redirect to a CDN host), verifies the
//      bytes against the manifest sha256 + size, and uploads to the US bucket.
//   3. Presigns the US object and records name -> URL.
// The name -> presigned-URL map is written to OUTPUT_MAP for the caller to feed
// into the addon's staging path (LLM prestage override / diffusion manifest
// rewrite).
//
// AWS auth comes from the ambient environment (the composite sets up an
// auto-refreshing credential_process profile), so this script never handles
// credentials directly — it just shells out to the AWS CLI.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync, rmSync, mkdtempSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function env(name, fallback) {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`[seed] required env ${name} is not set`)
  }
  return v
}

const MANIFEST_PATH = env('MANIFEST_PATH')
const S3_BUCKET = env('S3_BUCKET')
// Prefix identifies the pilot key space; caller passes a trailing slash.
const S3_PREFIX = env('S3_PREFIX')
const AWS_REGION = env('AWS_REGION', 'us-west-2')
const OUTPUT_MAP = env('OUTPUT_MAP')
const EXPIRES_IN = env('EXPIRES_IN', '7200')
const HF_TOKEN = process.env.HF_TOKEN || ''

function s3Key(name) {
  return `${S3_PREFIX}${name}`
}

function headObjectSize(key) {
  try {
    const out = execFileSync(
      'aws',
      ['s3api', 'head-object', '--bucket', S3_BUCKET, '--key', key, '--region', AWS_REGION, '--output', 'json'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const meta = JSON.parse(out.toString('utf8'))
    return typeof meta.ContentLength === 'number' ? meta.ContentLength : null
  } catch {
    // Non-zero exit == object missing (or no access); treat as "needs seeding".
    return null
  }
}

function isHuggingFace(url) {
  try {
    return new URL(url).host === 'huggingface.co'
  } catch {
    return false
  }
}

function download(url, dest) {
  // curl strips the Authorization header on a cross-host redirect (HF -> CDN)
  // unless --location-trusted is passed, so sending the bearer token only for
  // huggingface.co origins is safe: it authenticates the gated repo lookup and
  // is dropped before the signed CDN URL is fetched.
  const args = [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--retry',
    '6',
    '--retry-all-errors',
    '--retry-delay',
    '5',
    '--connect-timeout',
    '30',
    '--max-time',
    '3600',
    '-o',
    dest
  ]
  if (HF_TOKEN && isHuggingFace(url)) {
    args.push('-H', `Authorization: Bearer ${HF_TOKEN}`)
  }
  args.push(url)
  execFileSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] })
}

function sha256(file) {
  // Chunked read: model files reach ~11 GB, and readFileSync throws
  // ERR_FS_FILE_TOO_LARGE past the 2 GiB Buffer cap, so hash incrementally.
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024)
    let bytesRead
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex').toLowerCase()
}

function verify(file, entry, name) {
  const size = statSync(file).size
  if (Number.isInteger(entry.bytes) && size !== entry.bytes) {
    throw new Error(`[seed] ${name}: size ${size} != manifest ${entry.bytes}`)
  }
  if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)) {
    const got = sha256(file)
    if (got !== entry.sha256.toLowerCase()) {
      throw new Error(`[seed] ${name}: sha256 ${got} != manifest ${entry.sha256}`)
    }
  }
}

function upload(file, key) {
  execFileSync(
    'aws',
    ['s3', 'cp', file, `s3://${S3_BUCKET}/${key}`, '--region', AWS_REGION, '--only-show-errors'],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
}

function presign(key) {
  const out = execFileSync(
    'aws',
    ['s3', 'presign', `s3://${S3_BUCKET}/${key}`, '--region', AWS_REGION, '--expires-in', String(EXPIRES_IN)],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  return out.toString('utf8').trim()
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  if (!manifest || !manifest.models) {
    throw new Error(`[seed] manifest ${MANIFEST_PATH} has no models object`)
  }
  const names = Object.keys(manifest.models)
  console.log(`[seed] ${names.length} model(s) from ${MANIFEST_PATH}`)
  console.log(`[seed] destination s3://${S3_BUCKET}/${S3_PREFIX} (${AWS_REGION})`)

  const workDir = mkdtempSync(join(tmpdir(), 'seed-models-'))
  const map = {}
  let seeded = 0
  let present = 0

  for (const name of names) {
    const entry = manifest.models[name]
    const urls = Array.isArray(entry.urls) ? entry.urls : []
    if (urls.length === 0) throw new Error(`[seed] ${name}: no urls in manifest`)
    const key = s3Key(name)

    const existingSize = headObjectSize(key)
    const alreadySeeded =
      existingSize !== null && (!Number.isInteger(entry.bytes) || existingSize === entry.bytes)

    if (alreadySeeded) {
      present++
      console.log(`[seed] ${name}: already in US bucket (${existingSize} bytes), skipping`)
    } else {
      const tmp = join(workDir, name)
      let lastErr = null
      let ok = false
      for (const url of urls) {
        try {
          console.log(`[seed] ${name}: downloading from ${new URL(url).host}`)
          download(url, tmp)
          verify(tmp, entry, name)
          ok = true
          break
        } catch (err) {
          lastErr = err
          console.log(`[seed] ${name}: source failed (${err.message}); trying next url if any`)
        }
      }
      if (!ok) throw lastErr || new Error(`[seed] ${name}: all sources failed`)
      console.log(`[seed] ${name}: uploading to s3://${S3_BUCKET}/${key}`)
      upload(tmp, key)
      try {
        rmSync(tmp, { force: true })
      } catch {}
      seeded++
    }

    map[name] = presign(key)
  }

  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {}

  writeFileSync(OUTPUT_MAP, JSON.stringify(map, null, 2) + '\n')
  console.log(`[seed] done: ${seeded} seeded, ${present} already present; map -> ${OUTPUT_MAP}`)
}

main()
