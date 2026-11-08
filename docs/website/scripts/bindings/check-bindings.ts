#!/usr/bin/env bun
/**
 * Check, or record, the bindings of every documented software's development
 * line.
 *
 * Usage:
 *   bun run scripts/bindings/check-bindings.ts [<software>…]          # docs:bindings
 *   bun run scripts/bindings/check-bindings.ts --write [<software>…]  # docs:lock
 *
 * For each software declared under `versions/` (or each one named, by its
 * URL slug), reads its documentation root from the working tree, projects its
 * public surface from the data the reference renders from, and compares the
 * pages' `binds:` with `api-bindings.lock.json`:
 *
 * - drift: a bound symbol's surface changed since the page's last review;
 * - coverage (a `product` only): a public symbol no page binds.
 *
 * `--write` rewrites each lock from the current bindings, which records the
 * review of every bound page; it still fails on what a lock cannot fix — an
 * unknown symbol, an uncovered one. Exits 1 naming each problem.
 *
 * Runs on pull requests, never in the build: a line already published is
 * not checked again.
 */
import * as path from 'node:path'
import { declaredSoftware } from '../../src/lib/versions'
import { checkBindings, lockFor, readLock, scanPages, writeLock, type BindingProblem } from './bindings'
import { projectSurface } from './surface'

const MONOREPO = path.resolve(import.meta.dirname, '..', '..', '..', '..')

/** Problems `--write` resolves by recording the review. */
const RECORDED_BY_LOCK = new Set<BindingProblem['kind']>(['drift', 'unreviewed', 'stale-lock'])

export function run(args: string[], root = MONOREPO): number {
  const write = args.includes('--write')
  const only = args.filter((arg) => !arg.startsWith('--'))
  const declared = declaredSoftware().map((entry) => entry.declaration)
  const unknown = only.filter((slug) => !declared.some((declaration) => declaration.path === `/${slug}`))
  if (unknown.length > 0) {
    console.error(`No versions file declares ${unknown.map((slug) => `/${slug}`).join(', ')}.`)
    return 1
  }

  let failed = false
  for (const declaration of declared) {
    if (only.length > 0 && !only.includes(declaration.path.slice(1))) continue
    const docsRoot = path.join(root, declaration.paths[0])
    const surface = projectSurface({ root, paths: declaration.paths })
    const scan = scanPages(docsRoot)
    if (surface.size === 0 && scan.bindings.size === 0) continue

    if (write) writeLock(docsRoot, lockFor(scan.bindings, surface))
    const problems = checkBindings({ kind: declaration.kind, surface, scan, lock: readLock(docsRoot) })
    const remaining = write ? problems.filter((problem) => !RECORDED_BY_LOCK.has(problem.kind)) : problems

    const label = `${declaration.package} (${declaration.kind}, ${path.relative(root, docsRoot)})`
    if (remaining.length === 0) {
      console.log(`✓ ${label}: ${scan.bindings.size} pages bind ${surface.size} public symbols${write ? '; lock written' : ''}.`)
      continue
    }
    failed = true
    console.error(`✗ ${label}${write ? ': lock written, but' : ''}`)
    for (const problem of remaining) console.error(`  - ${problem.message}`)
    if (!write && remaining.some((problem) => RECORDED_BY_LOCK.has(problem.kind))) {
      console.error('  Review the named pages against the changed surface, then run `npm run docs:lock` and commit the lock.')
    }
  }
  return failed ? 1 : 0
}

if (import.meta.main) process.exit(run(process.argv.slice(2)))
