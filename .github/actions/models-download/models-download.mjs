#!/usr/bin/env node
// S3 only for now; the first HuggingFace-sourced package to migrate adds its source.

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail)
  })

// Unpinned entries pass on presence, as the S3 stager did.
export async function matches(file, entry) {
  if (!existsSync(file)) return false
  if (entry.bytes != null && statSync(file).size !== entry.bytes) return false
  if (entry.sha256 != null && (await sha256(file)) !== entry.sha256) return false
  return true
}

// An entry's `skip` lists <platform>-<arch> hosts that never need it.
export async function download({
  manifest,
  workdir,
  target,
  host = `${process.platform}-${process.arch}`,
  fetchObject
}) {
  if (manifest.source !== 's3')
    throw new Error(`models-download supports source "s3" only, got "${manifest.source}"`)
  let fetched = 0
  for (const [name, m] of Object.entries(manifest.models || {})) {
    if (target && m.targets && !m.targets.includes(target)) continue
    if (m.skip?.includes(host)) continue
    const file = join(workdir, m.dest)
    if (await matches(file, m)) continue
    mkdirSync(dirname(file), { recursive: true })
    rmSync(file, { force: true })
    fetchObject(m.s3Path, file)
    if (!(await matches(file, m)))
      throw new Error(`${name}: downloaded file does not match its pinned size or sha256`)
    fetched++
  }
  return fetched
}

async function main(env) {
  const manifest = JSON.parse(
    readFileSync(join(env.WORKDIR, env.MANIFEST || 'test/integration/models.manifest.json'), 'utf8')
  )
  const fetched = await download({
    manifest,
    workdir: env.WORKDIR,
    target: env.TARGET,
    fetchObject: (key, file) =>
      execFileSync('aws', ['s3', 'cp', `s3://${env.BUCKET}/${key}`, file, '--only-show-errors'], {
        stdio: 'inherit'
      })
  })
  console.log(`Fetched ${fetched} model files`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)
