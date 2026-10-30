#!/usr/bin/env node
'use strict'

// Stage every models.manifest.json entry that declares an `s3Path` (and no HF
// `urls`) into test/model by copying it from the QVAC model registry bucket.
// Present files that pass the sha256/bytes pins are left alone; a fresh copy
// that fails them fails the step.
//
// Usage:
//   MODEL_S3_BUCKET=my-bucket node scripts/stage-s3-models.mjs [--output <dir>]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function verify(file, entry) {
  if (!existsSync(file)) return 'missing'
  const size = statSync(file).size
  if (size !== entry.bytes) return `size ${size} != ${entry.bytes}`
  const got = await sha256(file)
  if (got !== entry.sha256.toLowerCase()) return `sha256 ${got} != ${entry.sha256}`
  return null
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

  const bucket = process.env.MODEL_S3_BUCKET
  mkdirSync(args.output, { recursive: true })

  for (const [name, entry] of entries) {
    const dest = join(args.output, name)
    const cached = await verify(dest, entry)
    if (cached === null) {
      console.log(`[stage-s3] ${name}: present + verified — skip`)
      continue
    }
    if (!bucket) throw new Error('[stage-s3] MODEL_S3_BUCKET is not set')

    console.log(`[stage-s3] ${name}: ${cached} — copying ${entry.s3Path}`)
    const part = `${dest}.part`
    rmSync(part, { force: true })
    const cp = spawnSync(
      'aws',
      ['s3', 'cp', `s3://${bucket}/${entry.s3Path}`, part, '--only-show-errors'],
      {
        stdio: 'inherit'
      }
    )
    if (cp.status !== 0) {
      rmSync(part, { force: true })
      throw new Error(`[stage-s3] ${name}: aws s3 cp exited ${cp.status ?? cp.error?.message}`)
    }
    const fresh = await verify(part, entry)
    if (fresh !== null) {
      rmSync(part, { force: true })
      throw new Error(`[stage-s3] ${name}: copied file failed integrity: ${fresh}`)
    }
    renameSync(part, dest)
    console.log(`[stage-s3] ${name}: staged (${entry.bytes} bytes)`)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
