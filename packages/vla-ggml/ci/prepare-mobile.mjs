#!/usr/bin/env node
// Bakes presigned model URLs and fixtures into the mobile test assets, and emits the host pre-stage commands.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const ASSETS = join(PKG, 'test/mobile/testAssets')

export const MODELS = [
  {
    base: 'qvac_models_compiled/vla/smolvla-libero',
    name: 'smolvla-libero-vision-q8.gguf',
    out: 'smolvla-urls.json'
  },
  {
    base: 'qvac_models_compiled/vla/groot-n1.7-3b-multi',
    name: 'groot-q5_vf16.gguf',
    out: 'groot-urls.json'
  }
]
// The same PyTorch references the desktop suite compares against.
export const FIXTURES = [
  'pt_actions_libero_fixed.json',
  'pt_actions_libero_real.json',
  'libero_real_left.bin',
  'libero_real_right.bin'
]

// `aws s3 ls` lists dated prefixes as "PRE 2026-04-30/"; the newest wins.
export function latestDate(listing) {
  const dates = [...listing.matchAll(/PRE\s+([^/\s]+)\//g)].map((m) => m[1]).sort()
  if (!dates.length) throw new Error('no dated model directories')
  return dates.at(-1)
}

export function urlConfig({ url, size, sha256 }) {
  return {
    modelUrl: url,
    ...(size ? { sizeBytes: Number(size) } : {}),
    ...(sha256 ? { sha256 } : {})
  }
}

function presign(m, { bucket, region, aws }) {
  const key = `${m.base}/${latestDate(aws(['s3', 'ls', `s3://${bucket}/${m.base}/`]))}/${m.name}`
  const size = JSON.parse(
    aws(['s3api', 'head-object', '--bucket', bucket, '--key', key])
  ).ContentLength
  let sha256 = ''
  try {
    const f = join(mkdtempSync(join(tmpdir(), 'sha-')), 'sha256')
    aws(['s3', 'cp', `s3://${bucket}/${key}.sha256`, f, '--quiet'])
    sha256 = readFileSync(f, 'utf8').trim().split(/\s+/)[0]
  } catch {}
  const url = aws(['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', '21600']).trim()
  if (!url) throw new Error(`could not presign ${m.name}`)
  // The URL carries credentials.
  console.log(`::add-mask::${url}`)
  console.log(`${m.name}: ${size} bytes${sha256 ? ', sha256 pinned' : ''} (region ${region})`)
  return urlConfig({ url, size, sha256 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const region = env.AWS_REGION || 'us-west-2'
  const aws = (args) => execFileSync('aws', [...args, '--region', region], { encoding: 'utf8' })
  console.log(`::add-mask::${env.MODEL_S3_BUCKET}`)
  mkdirSync(ASSETS, { recursive: true })
  for (const m of MODELS) {
    const config = presign(m, { bucket: env.MODEL_S3_BUCKET, region, aws })
    writeFileSync(join(ASSETS, m.out), JSON.stringify(config))
  }
  for (const f of FIXTURES) {
    const src = join(PKG, 'test/integration/assets', f)
    if (existsSync(src)) copyFileSync(src, join(ASSETS, f))
    else console.log(`${f} missing; the mobile suite skips that fixture`)
  }
  const block = execFileSync(
    'node',
    [join(PKG, 'scripts/generate-prestage-block.js'), env.PLATFORM.toLowerCase()],
    { encoding: 'utf8' }
  )
  appendFileSync(env.GITHUB_OUTPUT, `pre-test-commands<<PRESTAGE_EOF\n${block}\nPRESTAGE_EOF\n`)
}
