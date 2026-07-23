#!/usr/bin/env node
// scripts/coload-combinations.mjs
//
// Emits a GitHub Actions matrix (a JSON array of { name, addons }) describing
// which addon combinations the co-load smoke should run. Consumed via
// fromJSON() in the desktop / mobile co-load workflows.
//
// Modes:
//   full (default): ALL + each multi-addon stack + cross-stack pairs + the
//                   one-per-stack triple. The ALL combo alone already co-loads
//                   every pair of addons; the smaller combos exist to localize
//                   which addon / ggml stack regressed and to surface
//                   load-order-sensitive interposition.
//   changed:        given CHANGED_ADDONS=a,b (the addon packages a PR touched),
//                   emit focus combos -- each changed addon with its own stack
//                   (same ggml prefix => highest interposition risk), plus the
//                   ALL combo -- so PRs stay cheap but still see the change in
//                   the full set.
//
// Usage:
//   node scripts/coload-combinations.mjs
//   node scripts/coload-combinations.mjs --mode changed --changed tts-ggml,llm-llamacpp
//   CHANGED_ADDONS=tts-ggml node scripts/coload-combinations.mjs

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const { ADDONS, allNames, stacks } = require(join(here, '..', 'addons.js'))

function parseArgs (argv) {
  const opts = {
    mode: process.env.CHANGED_ADDONS ? 'changed' : 'full',
    changed: process.env.CHANGED_ADDONS || '',
    changedFiles: '',
    mobile: false,
    only: ''
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') opts.mode = argv[++i]
    else if (argv[i] === '--changed') { opts.changed = argv[++i]; opts.mode = 'changed' }
    else if (argv[i] === '--changed-files') { opts.changedFiles = argv[++i]; opts.mode = 'changed' }
    else if (argv[i] === '--mobile') opts.mobile = true
    else if (argv[i] === '--only') opts.only = argv[++i]
  }
  return opts
}

// Derive the set of changed addons from a `git diff --name-only` file list:
// any path under packages/<name>/ where <name> is a known addon.
function changedFromDiff (diffFile) {
  const names = allNames()
  const changed = new Set()
  let content = ''
  try { content = readFileSync(diffFile, 'utf8') } catch { return [] }
  for (const line of content.split('\n')) {
    const m = line.match(/^packages\/([^/]+)\//)
    if (m && names.includes(m[1])) changed.add(m[1])
  }
  return [...changed]
}

function combo (name, names) {
  // `plugins` is the SDK bundle specifier list for the subset of these addons
  // that expose a built-in SDK plugin -- used by the mobile (Device Farm)
  // co-load to bundle a consumer with only this subset.
  const plugins = names
    .map(n => ADDONS[n].plugin)
    .filter(Boolean)
    .map(suffix => `@qvac/sdk/${suffix}/plugin`)
  return { name, addons: names.join(','), plugins: plugins.join(',') }
}

function dedupe (combos) {
  const seen = new Set()
  const out = []
  for (const c of combos) {
    const key = c.addons.split(',').sort().join(',')
    if (seen.has(key) || c.addons === '') continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function fullMatrix () {
  const byStack = stacks()
  const combos = [combo('all', allNames())]

  for (const [stack, names] of Object.entries(byStack)) {
    if (names.length >= 2) combos.push(combo(`stack-${stack}`, names))
  }

  // Cross-stack: one representative addon per stack -> every stack pair + the
  // one-per-stack triple. These co-load DIFFERENT ggml copies in one process.
  const reps = Object.entries(byStack).map(([stack, names]) => ({ stack, addon: names[0] }))
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      combos.push(combo(`cross-${reps[i].stack}-${reps[j].stack}`, [reps[i].addon, reps[j].addon]))
    }
  }
  if (reps.length >= 3) combos.push(combo('cross-all-stacks', reps.map(r => r.addon)))

  return dedupe(combos)
}

function changedMatrix (changedCsv) {
  const byStack = stacks()
  const changed = changedCsv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(n => ADDONS[n])

  if (changed.length === 0) return fullMatrix()

  const combos = []
  for (const x of changed) {
    const stack = ADDONS[x].stack
    const stackNames = byStack[stack]
    if (stackNames.length >= 2) {
      // Co-load the changed addon with its same-ggml-prefix siblings.
      combos.push(combo(`${x}-with-${stack}`, stackNames))
    } else {
      // Singleton stack (e.g. diffusion): co-load with a rep from each other stack.
      const others = Object.entries(byStack)
        .filter(([s]) => s !== stack)
        .map(([, names]) => names[0])
      combos.push(combo(`${x}-cross-stack`, [x, ...others]))
    }
  }
  combos.push(combo('all', allNames()))
  return dedupe(combos)
}

const opts = parseArgs(process.argv.slice(2))
let matrix
if (opts.mode === 'changed') {
  const changedCsv = opts.changedFiles ? changedFromDiff(opts.changedFiles).join(',') : opts.changed
  matrix = changedMatrix(changedCsv)
} else {
  matrix = fullMatrix()
}
// Mobile co-load goes through the SDK bundle, which can only include addons
// that expose a built-in SDK plugin. Drop combos that would bundle fewer than
// two such addons (nothing to co-load on device).
if (opts.mobile) {
  matrix = matrix.filter(c => c.plugins.split(',').filter(Boolean).length >= 2)
}
// Keep only named combos (e.g. --only all to run just the full bundle on PRs).
if (opts.only) {
  const keep = new Set(opts.only.split(',').map(s => s.trim()).filter(Boolean))
  matrix = matrix.filter(c => keep.has(c.name))
}
const json = JSON.stringify(matrix)
process.stdout.write(json + '\n')

// Convenience for CI: also expose it as a step output `combos=<json>`.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `combos=${json}\n`)
}
