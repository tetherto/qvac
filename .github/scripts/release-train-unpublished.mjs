#!/usr/bin/env node
/**
 * Fails when npm already has the version a release train PR moves a package
 * to. pr-release-guard.yml runs it with release-train-moved.mjs's output.
 *
 * Usage: node .github/scripts/release-train-unpublished.mjs '<moved-json>'
 */
import { spawnSync } from 'node:child_process'
import { alreadyOnNpm } from './lib/release-train-guard.mjs'
import { isPublished } from './lib/release-train-publish.mjs'

function run (command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function main () {
  const [movedJson] = process.argv.slice(2)
  if (movedJson === undefined) {
    console.error("usage: release-train-unpublished.mjs '<moved-json>'")
    process.exit(2)
  }
  const moved = JSON.parse(movedJson)
  const taken = alreadyOnNpm(moved, (name, version) => isPublished(name, version, run))
  for (const project of taken) {
    console.error(
      `::error::${project.name}@${project.version} is already on npm. The train would skip it and ` +
        'ship without its changes; move it to a version npm does not have.'
    )
  }
  if (taken.length > 0) process.exit(1)
  for (const project of moved) {
    console.log(`${project.name}@${project.version}: not on npm yet`)
  }
}

main()
