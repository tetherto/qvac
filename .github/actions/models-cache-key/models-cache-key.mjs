#!/usr/bin/env node
// The key hashes the manifest alone, so test or CI edits never throw models away.

import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

export function entriesFor(manifest, target) {
  return Object.entries(manifest.models || {})
    .filter(([, m]) => !target || !m.targets || m.targets.includes(target))
    .map(([name, m]) => ({ name, ...m }))
}

export function resolve({ manifestText, workdir, target, version = 'v1' }) {
  const manifest = JSON.parse(manifestText)
  const entries = entriesFor(manifest, target)
  const hash = createHash('sha256').update(manifestText).digest('hex').slice(0, 16)
  const prefix = `models-${basename(workdir)}-${target ? target.replace(/[^A-Za-z0-9]+/g, '-') : 'all'}-${version}-`
  const dirs = [...new Set(entries.map((e) => posix.join(workdir, dirname(e.dest))))].sort()
  // A directory inside another listed one is already cached with it.
  const paths = dirs.filter((d) => !dirs.some((o) => d.startsWith(`${o}/`)))
  return { key: `${prefix}${hash}`, prefix, paths, count: entries.length }
}

function main(env) {
  const manifestPath = join(env.WORKDIR, env.MANIFEST || 'test/integration/models.manifest.json')
  const r = resolve({
    manifestText: readFileSync(manifestPath, 'utf8'),
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
