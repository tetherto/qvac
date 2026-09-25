#!/usr/bin/env node
/**
 * The only way release-train.yml publishes to npm. See
 * .github/scripts/lib/release-train-publish.mjs for why it publishes one
 * package per nx call.
 *
 * Usage:
 *   node .github/scripts/release-train-publish.mjs <train> [--tag <dist-tag>] [--dry-run]
 */
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { publishTrain } from './lib/release-train-publish.mjs'
import { readRepoFile, repoRoot } from './lib/release-trains.mjs'

function run (command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function main () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
  })

  const [train] = positionals
  if (!train || positionals.length > 1) {
    console.error('usage: release-train-publish.mjs <train> [--tag <dist-tag>] [--dry-run]')
    process.exit(2)
  }

  const result = publishTrain({
    train,
    requestedTag: values.tag,
    dryRun: values['dry-run'],
    readManifest: readRepoFile,
    run,
  })

  const verb = values['dry-run'] ? 'would publish' : 'published'
  for (const entry of result.published) {
    console.log(`${verb} ${entry.name}@${entry.version} (${entry.tag})`)
  }
  if (result.failed) {
    console.error(`::error::${result.failed.name}@${result.failed.version} failed to publish`)
    for (const entry of result.notAttempted) {
      console.error(`::error::${entry.name}@${entry.version} was not attempted`)
    }
    console.error('Re-run the workflow to publish the rest; versions already on npm are skipped.')
    process.exit(1)
  }
}

main()
