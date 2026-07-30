#!/usr/bin/env node
/**
 * One-shot: harden authorize / resolve-config jobs that invoke authorize-pr.
 * - needs: [fork-approval] so fork-ci runs before any authorize-pr composite
 * - checkout authorize-pr from default branch only (sparse), never PR merge ref
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

const CHECKOUT_ACTION =
  'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # 6.0.2'

const TRUSTED_CHECKOUT = `      - name: Checkout authorize-pr (default branch)
        uses: ${CHECKOUT_ACTION}
        with:
          ref: \${{ github.event.repository.default_branch }}
          sparse-checkout: .github/actions/authorize-pr
          sparse-checkout-cone-mode: false
          persist-credentials: false
`

function patchAuthorizeJobBlock(block) {
  if (!block.includes('./.github/actions/authorize-pr')) {
    return block
  }

  let next = block

  if (!/\bneeds:\s*\n\s*- fork-approval\b/.test(next) && !/\bneeds:\s*\[fork-approval\]/.test(next)) {
    next = next.replace(
      /^((?:  authorize:|  resolve-config:)\n(?:    .+\n)*?)(    runs-on:)/m,
      '$1    needs: [fork-approval]\n$2',
    )
  }

  if (!next.includes('sparse-checkout: .github/actions/authorize-pr')) {
    next = next.replace(
      /      - name: Checkout(?: code| authorize-pr \(default branch\))?\n        uses: actions\/checkout@[^\n]+\n(?:        with:\n(?:          [^\n]+\n)+)?/,
      TRUSTED_CHECKOUT,
    )
  }

  return next
}

function processFile(path) {
  let source = readFileSync(path, 'utf8')
  if (!source.includes('./.github/actions/authorize-pr')) {
    return false
  }

  const jobsIdx = source.indexOf('\njobs:\n')
  if (jobsIdx === -1) {
    return false
  }

  const header = source.slice(0, jobsIdx + 1)
  const rest = source.slice(jobsIdx + 1)
  const jobNames = ['authorize', 'resolve-config']
  let changed = false
  let body = rest

  for (const jobName of jobNames) {
    const marker = `\n  ${jobName}:\n`
    let start = body.indexOf(marker)
    if (start === -1) {
      continue
    }
    start += 1
    const after = body.slice(start + marker.length - 1)
    const nextJob = after.search(/\n  [A-Za-z0-9_-]+:\n/)
    const end = nextJob === -1 ? body.length : start + marker.length - 1 + nextJob
    const block = body.slice(start, end)
    if (!block.includes('./.github/actions/authorize-pr')) {
      continue
    }
    const patched = patchAuthorizeJobBlock(block)
    if (patched !== block) {
      body = body.slice(0, start) + patched + body.slice(end)
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  let output = header + body
  if (!output.endsWith('\n')) {
    output += '\n'
  }
  writeFileSync(path, output)
  return true
}

let changed = 0
for (const name of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(name)) {
    continue
  }
  if (processFile(join(workflowsDir, name))) {
    changed++
    console.log(`patched: ${name}`)
  }
}
console.log(`done: ${changed} workflow(s)`)
