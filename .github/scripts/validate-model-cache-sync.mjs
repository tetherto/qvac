#!/usr/bin/env node
/**
 * Fail if an on-merge-model-cache-* seed writes a cache identity no consumer
 * asks for.
 *
 * The seeding scheme rests on each seed reproducing its consumer's
 * `cache-models` inputs. Drift is silent in both directions: the seed keeps
 * saving a key nothing restores, and its verify job asserts that same stale
 * key, so the run is green while every PR leg misses.
 *
 * Usage: node .github/scripts/validate-model-cache-sync.mjs
 */
import { KEY_INPUTS, collect, findOrphanedSeeds } from './lib/model-cache-sync.mjs'

function main() {
  const orphans = findOrphanedSeeds()
  const { seeds, consumers } = collect()

  if (orphans.length > 0) {
    console.error(`validate-model-cache-sync: ${orphans.length} seed identity(ies) nothing consumes:`)
    for (const o of orphans) {
      console.error(`\n  ${o.file}:${o.line}`)
      for (const part of o.id.split('|')) console.error(`      ${part}`)
      const near = consumers
        .filter((c) => c.id.split('|')[0] === o.id.split('|')[0])
        .map((c) => `${c.file}:${c.line}`)
      if (near.length) {
        console.error(`    consumers for this package: ${[...new Set(near)].join(', ')}`)
        console.error('    one of the key inputs above differs from all of them')
      } else {
        console.error('    no consumer references this package at all')
      }
    }
    console.error(`\n  Key inputs compared: ${KEY_INPUTS.join(', ')}`)
    process.exit(1)
  }

  console.log(
    `validate-model-cache-sync: ok (${seeds.length} seed identities, all consumed; ` +
      `${consumers.length} consumer identities)`,
  )
}

main()
