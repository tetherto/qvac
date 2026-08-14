'use strict'
// Seed-if-missing + presign for mobile e2e model sourcing. Mirrors the models a
// run needs from the addon's pinned manifest into the US bucket (idempotent),
// then presigns each object and writes a name -> URL map for the caller.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync, rmSync, mkdtempSync, openSync, readSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'

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
const S3_PREFIX = env('S3_PREFIX')
const AWS_REGION = env('AWS_REGION', 'us-west-2')
const OUTPUT_MAP = env('OUTPUT_MAP')
const EXPIRES_IN = env('EXPIRES_IN', '7200')
const HF_TOKEN = process.env.HF_TOKEN || ''
const MODEL_NAMES = (process.env.MODEL_NAMES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Model names come from a PR-controlled manifest and are used to build both the
// S3 key and a local file path, so reject anything that could escape the prefix
// or the work dir (path traversal on shared self-hosted runners).
function validateModelName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    isAbsolute(name)
  ) {
    throw new Error(`[seed] invalid model name: ${JSON.stringify(name)}`)
  }
  return name
}

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
  // Only send the HF token to huggingface.co; curl drops it on the cross-host
  // redirect to the signed CDN (no --location-trusted), so it never leaks.
  if (HF_TOKEN && isHuggingFace(url)) {
    args.push('-H', `Authorization: Bearer ${HF_TOKEN}`)
  }
  args.push(url)
  execFileSync('curl', args, { stdio: ['ignore', 'inherit', 'inherit'] })
}

function sha256(file) {
  // Chunked: models reach ~11 GB and readFileSync throws past the 2 GiB cap.
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
  let names = Object.keys(manifest.models)
  if (MODEL_NAMES.length > 0) {
    const missing = MODEL_NAMES.filter((n) => !manifest.models[n])
    if (missing.length) {
      throw new Error(`[seed] MODEL_NAMES not in manifest: ${missing.join(', ')}`)
    }
    names = MODEL_NAMES
  }
  names.forEach(validateModelName)
  console.log(`[seed] ${names.length} model(s) to seed (manifest has ${Object.keys(manifest.models).length})`)
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
