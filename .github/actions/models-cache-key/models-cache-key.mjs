#!/usr/bin/env node
// The key hashes the manifest alone, so test or CI edits never throw models away.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

// Same selection and destinations as models-download: no targets means test:integration, url entries land in test/model/<name>, warm: false ones are not cached.
export function entriesFor(manifest, target) {
  return Object.entries(manifest.models || {})
    .filter(
      ([, m]) =>
        (!target || (m.targets ?? ['test:integration']).includes(target)) && m.warm !== false
    )
    .map(([name, m]) => ({ name, ...m, dest: m.dest ?? `test/model/${name}` }))
}

export function resolve({
  manifestText,
  manifest = JSON.parse(manifestText),
  workdir,
  target,
  version = 'v1'
}) {
  const entries = entriesFor(manifest, target)
  const hash = createHash('sha256').update(manifestText).digest('hex').slice(0, 16)
  const prefix = `models-${basename(workdir)}-${target ? target.replace(/[^A-Za-z0-9]+/g, '-') : 'all'}-${version}-`
  // An s3Prefix entry's dest is the directory itself.
  const dirOf = (e) => (e.s3Prefix ? e.dest.replace(/\/+$/, '') : dirname(e.dest))
  const dirs = [...new Set(entries.map((e) => posix.join(workdir, dirOf(e))))].sort()
  // A directory inside another listed one is already cached with it.
  const paths = dirs.filter((d) => !dirs.some((o) => d.startsWith(`${o}/`)))
  return { key: `${prefix}${hash}`, prefix, paths, count: entries.length }
}

// The package's one model manifest; a package without one has no models.
export function loadManifest(workdir, path = 'test/integration/models.manifest.json') {
  const file = join(workdir, path)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return { text, manifest: { models: text ? JSON.parse(text).models : {} } }
}

function main(env) {
  const { text, manifest } = loadManifest(env.WORKDIR, env.MANIFEST || undefined)
  const r = resolve({
    manifestText: text,
    manifest,
    workdir: env.WORKDIR,
    target: env.TARGET,
    version: env.VERSION
  })
  console.log(`${r.count} models, key ${r.key}`)
  appendFileSync(
    env.GITHUB_OUTPUT,
    `key=${r.key}\nrestore-prefix=${r.prefix}\npaths<<EOF\n${r.paths.join('\n')}\nEOF\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)
