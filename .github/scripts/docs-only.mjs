#!/usr/bin/env node
/**
 * Classify the change between two commits as documentation-only or not.
 *
 * Usage: node .github/scripts/docs-only.mjs <base-sha> <head-sha>
 *
 * Diffs from the merge base of the two commits, so commits already on the
 * base branch are not read as the change's. Prints the verdict and the
 * changed paths, and, under GitHub Actions, writes `docs_only=true|false` and
 * `packages=<json array>` to `$GITHUB_OUTPUT`. The rule lives in
 * `lib/docs-only.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { docsPackages, isDocsOnly } from './lib/docs-only.mjs'

const [base, head] = process.argv.slice(2)
if (!base || !head) {
  console.error('usage: docs-only.mjs <base-sha> <head-sha>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf-8' }).trim()
const mergeBase = git('merge-base', base, head)
const paths = git('diff', '--name-only', mergeBase, head).split('\n').filter(Boolean)
const docsOnly = isDocsOnly(paths)
const packages = docsPackages(paths)

console.log(`${docsOnly ? 'Documentation-only' : 'Not documentation-only'}: ${paths.length} changed path(s)`)
for (const path of paths) console.log(`  ${path}`)

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\npackages=${JSON.stringify(packages)}\n`)
}
