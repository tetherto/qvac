#!/usr/bin/env node
/**
 * Release train merge guard. See .github/scripts/lib/release-train-guard.mjs
 * for what it checks and why the per-package guard cannot do it.
 *
 * Usage: node .github/scripts/validate-release-train.mjs <ref> <base-sha> <head-sha>
 */
import { execFileSync } from 'node:child_process'
import { checkReleaseTrain } from './lib/release-train-guard.mjs'

function main () {
  const [ref, baseSha, headSha] = process.argv.slice(2)

  if (!ref || !headSha) {
    console.error('usage: validate-release-train.mjs <ref> <base-sha> <head-sha>')
    process.exit(2)
  }

  const errors = checkReleaseTrain(ref, baseSha, {
    readManifest: (path) =>
      execFileSync('git', ['show', `${headSha}:${path}`], { encoding: 'utf-8' }),
    changedFiles: () =>
      execFileSync('git', ['diff', '--name-only', baseSha, headSha], {
        encoding: 'utf-8',
      })
        .split('\n')
        .filter(Boolean),
  })

  for (const err of errors) {
    console.error(`::error::${err}`)
  }

  if (errors.length) {
    console.error(`Release train guard failed with ${errors.length} error(s)`)
    process.exit(1)
  }

  console.log('Release train guard passed')
}

main()
