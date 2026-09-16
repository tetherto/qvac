import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A ts-check is published by on-pr-ts-nx and awaited, by literal name, from
// several other places. Nothing in the repo connects the two ends: rename a job
// id and it silently stops satisfying its pollers, and the only symptom is an
// await burning its 25 minute timeout, on someone else's PR, days later. That
// is the failure this suite catches at PR time instead.
//
// Parsed with regexes rather than a YAML library on purpose: these suites run
// on bare node with no dependencies, matching the others in this directory.

const root = fileURLToPath(new URL('../../..', import.meta.url))
const workflows = join(root, '.github/workflows')
const producerPath = join(workflows, 'on-pr-ts-nx.yml')

// With or without the reusable's "/ ts-checks" suffix; diffusion runs its steps
// inline and so has no suffix.
const nameRe = /['"]([A-Za-z0-9._-]*pr-head-ts-checks(?: \/ ts-checks)?)['"]/g

const scanned = new Set(['.yml', '.yaml', '.mjs', '.js', '.json', '.md'])
const skip = new Set(['.git', 'node_modules', 'prebuilds', 'dist', 'build'])

function walk(directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (skip.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (scanned.has(path.slice(path.lastIndexOf('.')))) out.push(path)
  }
  return out
}

// Top-level jobs of the producer, as [id, body] where body is the raw block.
function producerJobs() {
  const source = readFileSync(producerPath, 'utf8')
  const jobsBlock = source.slice(source.indexOf('\njobs:') + 1)
  const jobs = []
  const headings = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)]
  for (const [index, heading] of headings.entries()) {
    const start = heading.index + heading[0].length
    const end = index + 1 < headings.length ? headings[index + 1].index : jobsBlock.length
    jobs.push([heading[1], jobsBlock.slice(start, end)])
  }
  return jobs
}

// The check run a job publishes: "<name or id> / ts-checks" when it calls the
// reusable, and just the job name when it runs its steps inline.
function publishedNames() {
  const names = new Map()
  for (const [id, body] of producerJobs()) {
    if (id === 'matrix') continue
    const label = body.match(/^ {4}name:\s*(.+)$/m)?.[1].trim() ?? id
    const callsReusable = / {4}uses:\s*\.\/\.github\/workflows\/reusable-ts-checks\.yml/.test(body)
    names.set(callsReusable ? `${label} / ts-checks` : label, id)
  }
  return names
}

test('on-pr-ts-nx publishes a check for every package on-pr-nx awaits', () => {
  const published = publishedNames()
  const nx = readFileSync(join(workflows, 'on-pr-nx.yml'), 'utf8')

  // on-pr-nx builds the awaited name per package in a jq map; read it back out.
  const mapped = [...nx.matchAll(/"([a-z0-9-]+)":\s*"([^"]*pr-head-ts-checks[^"]*)"/g)]
  assert.ok(
    mapped.length >= 8,
    `expected on-pr-nx to map at least 8 packages, found ${mapped.length}`
  )

  for (const [, pkg, awaited] of mapped) {
    assert.ok(
      published.has(awaited),
      `on-pr-nx awaits "${awaited}" for ${pkg}, which on-pr-ts-nx never publishes.\n` +
        `published: ${[...published.keys()].sort().join(', ')}`
    )
  }
})

test('every ts-check name referenced in the repo is actually published', () => {
  const published = publishedNames()
  const orphans = []

  for (const file of walk(root)) {
    if (file === producerPath) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(nameRe)) {
      if (!published.has(match[1])) {
        orphans.push(`${match[1]} <- ${relative(root, file)}`)
      }
    }
  }

  assert.deepEqual(
    [...new Set(orphans)],
    [],
    'polled but never published, so the await would time out:\n  ' +
      [...new Set(orphans)].join('\n  ')
  )
})

test('each producer job is gated on the nx-affected list', () => {
  for (const [id, body] of producerJobs()) {
    if (id === 'matrix') continue
    const guard = body.match(/^ {4}if:\s*(.+)$/m)?.[1].trim()
    assert.ok(guard, `${id} has no if:, so it runs even when nx did not select it`)
    assert.match(
      guard,
      /contains\(fromJSON\(needs\.matrix\.outputs\.tspackages\), '[a-z0-9-]+'\)/,
      `${id} must gate on the nx-affected list, got: ${guard}`
    )
    assert.match(body, /^ {4}needs:.*matrix/m, `${id} must need the matrix job`)
  }
})
