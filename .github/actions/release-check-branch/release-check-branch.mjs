#!/usr/bin/env node
// A wrong selection must never reach npm: the branch names the one package and version a release may publish.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseRelease(ref) {
  const m = /^release-(.+)-([0-9]+\.[0-9]+\.[0-9]+)$/.exec(ref)
  if (!m) throw new Error(`expected release-<package dir>-<x.y.z>, got ${ref}; see docs/gitflow.md`)
  return { dir: m[1], version: m[2] }
}

export function problems({ ref, packages, version }) {
  const want = parseRelease(ref)
  const out = []
  if (packages.length !== 1 || packages[0] !== want.dir)
    out.push(
      `${ref} publishes packages/${want.dir} alone; this run would publish ${JSON.stringify(packages)}`
    )
  if (version !== undefined && version !== want.version)
    out.push(`${ref} releases ${want.version}, but packages/${want.dir}/package.json is ${version}`)
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const packages = JSON.parse(env.PACKAGES).map((p) => p.split('/').pop())
  const version = env.WORKDIR
    ? JSON.parse(readFileSync(join(env.WORKDIR, 'package.json'), 'utf8')).version
    : undefined
  const found = problems({ ref: env.GITHUB_REF_NAME, packages, version })
  for (const p of found) console.log(`::error title=Release guard::${p}`)
  if (found.length) process.exit(1)
  console.log(`OK: ${env.GITHUB_REF_NAME} publishes ${packages[0]}${version ? `@${version}` : ''}`)
}
