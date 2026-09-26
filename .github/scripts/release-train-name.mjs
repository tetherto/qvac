#!/usr/bin/env node
/**
 * Print the train a release branch belongs to, so workflows do not parse the
 * branch shape themselves.
 *
 * Usage: node .github/scripts/release-train-name.mjs <ref>
 */
import { getTrain, parseBranch } from './lib/release-trains.mjs'

function main () {
  const [ref] = process.argv.slice(2)

  if (!ref) {
    console.error('usage: release-train-name.mjs <ref>')
    process.exit(2)
  }

  const parsed = parseBranch(ref)
  if (!parsed) {
    console.error(`::error::'${ref}' is not a release train branch (release-train-<train>-x.y.z)`)
    process.exit(1)
  }

  // Reports the known train names when the branch invents one.
  try {
    getTrain(parsed.train)
  } catch (err) {
    console.error(`::error::${err.message}`)
    process.exit(1)
  }

  console.log(parsed.train)
}

main()
