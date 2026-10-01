#!/usr/bin/env node
/**
 * Fails the train build when a workspace sibling it links, but does not
 * publish, is not on npm at the linked version. See
 * .github/scripts/lib/release-train-linked.mjs for why that matters here and
 * not in the per-package workflows.
 *
 * Usage: node .github/scripts/release-train-linked.mjs <train>
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { linkedOutsideTrain, unpublishedLinks } from './lib/release-train-linked.mjs'
import { isPublished } from './lib/release-train-publish.mjs'
import { readRepoFile, repoRoot } from './lib/release-trains.mjs'

function run (command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

/** A project's direct dependencies as pnpm resolved them in this install. */
function resolvedDeps (project) {
  const result = run('pnpm', ['--filter', project.name, 'list', '--depth', '0', '--json'])
  if (result.status !== 0) {
    throw new Error(`pnpm list ${project.name} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
  }
  const [entry] = JSON.parse(result.stdout)
  const manifest = JSON.parse(readRepoFile(join(project.dir, 'package.json')))
  const ranges = Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => manifest[field] ?? {}))

  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.entries(entry?.[field] ?? {}).map(([name, resolved]) => ({
      name,
      version: resolved.version ?? '',
      range: ranges[name] ?? '',
    }))
  )
}

function main () {
  const [train] = process.argv.slice(2)
  if (!train) {
    console.error('usage: release-train-linked.mjs <train>')
    process.exit(2)
  }

  const linked = linkedOutsideTrain(train, resolvedDeps, (name) => {
    const result = run('pnpm', ['--filter', name, 'list', '--depth', '-1', '--json'])
    if (result.status !== 0) {
      throw new Error(`pnpm list ${name} failed (exit ${result.status}): ${result.stderr || result.stdout}`)
    }
    const [entry] = JSON.parse(result.stdout)
    if (!entry?.version) throw new Error(`${name} is linked but has no workspace version`)
    return entry.version
  })

  const missing = unpublishedLinks(linked, (name, version) => isPublished(name, version, run))

  for (const dep of missing) {
    console.error(
      `::error::${dep.name}@${dep.version} is linked from the workspace but not on npm. ` +
        `${dep.dependents.join(', ')} would build against it while a consumer resolves ` +
        `"${dep.range}" to an older version. Release it first, or lower the range.`
    )
  }
  if (missing.length > 0) process.exit(1)

  for (const dep of linked) {
    console.log(`${dep.name}@${dep.version} on npm, linked by ${dep.dependents.join(', ')}`)
  }
  if (linked.length === 0) console.log('no workspace siblings outside the train')
}

main()
