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
import {
  KEY_INPUTS,
  collect,
  findKnownCollisions,
  findOrphanedSeeds,
  findParserGaps,
  findUnobservedKnownCollisions,
  findPrefixCollisions,
} from './lib/model-cache-sync.mjs'

function main() {
  // Before trusting anything below, check the parser still sees the repo.
  const gaps = findParserGaps()
  if (gaps.length > 0) {
    console.error('validate-model-cache-sync: the parser has gone blind, so every')
    console.error('other check below would pass vacuously:')
    for (const g of gaps) console.error(`  ${g}`)
    process.exit(1)
  }

  const vanished = findUnobservedKnownCollisions()
  if (vanished.length > 0) {
    console.error('validate-model-cache-sync: recorded collision(s) no longer observed.')
    console.error('Either the parser has degraded and is now hiding hazards, or these')
    console.error('were fixed and the entries should be deleted from KNOWN_COLLISIONS:')
    for (const k of vanished) {
      console.error(`  ${k.a} (${k.aSuffix || 'empty'}) <-> ${k.b} (${k.bSuffix || 'empty'})`)
      console.error(`      ${k.why}`)
    }
    process.exit(1)
  }

  const orphans = findOrphanedSeeds()
  const { seeds, consumers } = collect()

  const collisions = findPrefixCollisions()
  if (collisions.length > 0) {
    console.error(
      `validate-model-cache-sync: ${collisions.length} restore-key prefix collision(s) between consumers:`,
    )
    for (const c of collisions) {
      const short = c.shorter === '' ? '(empty)' : c.shorter
      console.error(`\n  suffix ${short} reaches suffix ${c.longer} in the same cache version`)
      console.error(`      ${c.a.file}:${c.a.line}  (suffix ${short})`)
      console.error(`      ${c.b.file}:${c.b.line}  (suffix ${c.longer})`)
      console.error(
        '    the shorter leg can prefix-match the longer entry, find its files already',
      )
      console.error(
        '    present, skip its download and save the superset under its own key',
      )
    }
    process.exit(1)
  }

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

  const known = findKnownCollisions()
  console.log(
    `validate-model-cache-sync: ok (${seeds.length} seed identities, all consumed; ` +
      `${consumers.length} consumer identities; no NEW restore-key prefix collisions)`,
  )
  if (known.length > 0) {
    console.log(`  ${known.length} collision(s) recorded as pre-existing on main:`)
    for (const c of known) {
      const short = c.shorter === '' ? '(empty)' : c.shorter
      console.log(`    ${c.a.file}:${c.a.line} (${short}) reaches ${c.b.file}:${c.b.line}`)
    }
  }
}

main()
