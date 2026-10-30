#!/usr/bin/env node
// Each entry names its own source: s3Path (one object), s3Prefix (a directory, synced into dest) or pinned urls.
// An entry without targets serves test:integration. A url entry without dest lands in test/model/<name>, as main's cache-models stages it; warm: false ones are left to the tests.

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

export const destOf = (name, m) => m.dest ?? `test/model/${name}`

// An entry's `skip` lists <platform>-<arch> hosts that never need it.
export async function download({
  manifest,
  workdir,
  target,
  host = `${process.platform}-${process.arch}`,
  fetchObject,
  syncPrefix,
  fetchUrls
}) {
  let fetched = 0
  for (const [name, m] of Object.entries(manifest.models || {})) {
    if (target && !(m.targets ?? ['test:integration']).includes(target)) continue
    if (m.skip?.includes(host) || m.warm === false) continue
    const dest = join(workdir, destOf(name, m))
    // A sync copies only what the directory lacks, so it runs every time.
    if (m.s3Prefix) {
      mkdirSync(dest, { recursive: true })
      syncPrefix(m.s3Prefix, dest, m.exclude ?? [])
      continue
    }
    if (await matches(dest, m)) continue
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { force: true })
    if (m.s3Path) fetchObject(m.s3Path, dest)
    else if (m.urls?.length) fetchUrls(m.urls, dest)
    else throw new Error(`${name}: an entry needs s3Path, s3Prefix or urls`)
    if (!(await matches(dest, m)))
      throw new Error(`${name}: downloaded file does not match its pinned size or sha256`)
    fetched++
  }
  return fetched
}

// The package's one model manifest; a package without one has no models.
export function loadManifest(workdir, path = 'test/integration/models.manifest.json') {
  const file = join(workdir, path)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { text, manifest: { models: text ? JSON.parse(text).models : {} } }
}

async function main(env) {
  const { manifest } = loadManifest(env.WORKDIR, env.MANIFEST || undefined)
  const aws = (args) => execFileSync('aws', [...args, '--only-show-errors'], { stdio: 'inherit' })
  const fetched = await download({
    manifest,
    workdir: env.WORKDIR,
    target: env.TARGET,
    fetchObject: (key, file) => aws(['s3', 'cp', `s3://${env.BUCKET}/${key}`, file]),
    syncPrefix: (prefix, dir, exclude) =>
      aws([
        's3',
        'sync',
        `s3://${env.BUCKET}/${prefix}`,
        dir,
        ...exclude.flatMap((g) => ['--exclude', g])
      ]),
    // Each mirror in turn, with curl's own retries; a pinned sha256 checks whichever answered.
    fetchUrls: (urls, file) => {
      for (const [i, url] of urls.entries()) {
        try {
          return execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, url], {
            stdio: 'inherit'
          })
        } catch (e) {
          if (i === urls.length - 1) throw e
        }
      }
    }
  })
  console.log(`Fetched ${fetched} model files`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)
