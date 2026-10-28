#!/usr/bin/env node
// Publishes the platform packages slice-platform-packages.mjs staged, before the meta, as on-merge-nx.yml did. npm has
// no transactions, so every slice is checked before any publishes, and the meta publishes only after this succeeds.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

// hit or miss; any npm view failure other than E404 is a registry error, so nothing publishes blind.
export function onNpm(name, version, view) {
  const r = view(['view', `${name}@${version}`, 'version'])
  if (r.status === 0 && r.stdout.trim()) return 'hit'
  if (r.status === 0 || /E404/.test(`${r.stdout}${r.stderr}`)) return 'miss'
  throw new Error(`could not query ${name}@${version} (exit ${r.status}): ${r.stderr.trim()}`)
}

// The slices to publish; an identical retry of a partial release resumes it, any other partial release stops it.
export function plan({ meta, slices, view, integrity }) {
  const metaState = onNpm(meta.name, meta.version, view)
  const publish = []
  for (const slice of slices) {
    const id = `${slice.name}@${slice.version}`
    if (onNpm(slice.name, slice.version, view) === 'miss') {
      publish.push(slice)
      continue
    }
    if (metaState === 'hit') {
      console.log(`${id} already on npm and ${meta.name}@${meta.version} is released, skipping`)
      continue
    }
    if (integrity.published(slice) !== integrity.staged(slice))
      throw new Error(
        `${id} is on npm from a different build and ${meta.name}@${meta.version} is not, so publishing would pair the meta with binaries from another commit. Bump the version.`
      )
    console.log(`${id} already on npm with identical contents, skipping`)
  }
  return publish
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8' })
  const slices = readdirSync(env.SLICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: join(env.SLICES_DIR, d.name), ...manifest(join(env.SLICES_DIR, d.name)) }))
  const publish = plan({
    meta: manifest(env.WORKDIR),
    slices,
    view: (args) => npm(args),
    integrity: {
      published: (s) =>
        execFileSync('npm', ['view', `${s.name}@${s.version}`, 'dist.integrity'], {
          encoding: 'utf8'
        }).trim(),
      // npm pack normalises mtimes, so re-slicing the same artifact reproduces the published tarball.
      staged: (s) =>
        JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], s.dir).stdout)[0]
          .integrity
    }
  })
  for (const s of publish) {
    console.log(
      `${env.DRY_RUN === 'true' ? 'Would publish' : 'Publishing'} ${s.name}@${s.version} with tag ${env.DIST_TAG}`
    )
    if (env.DRY_RUN === 'true') continue
    execFileSync('npm', ['publish', '--tag', env.DIST_TAG, '--access', 'public', '--provenance'], {
      cwd: s.dir,
      stdio: 'inherit'
    })
  }
}
