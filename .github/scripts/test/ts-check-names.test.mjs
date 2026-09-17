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

// The paths: list of one trigger, e.g. pull_request or pull_request_target.
// null when the trigger is absent; [] when it has no paths: filter at all,
// which means it fires on every change.
function triggerPaths(source, trigger) {
  const start = source.search(new RegExp(`^ {2}${trigger}:$`, 'm'))
  if (start === -1) return null

  const rest = source.slice(start)
  const next = rest.slice(1).search(/^ {2}\S/m)
  const block = next === -1 ? rest : rest.slice(0, next + 1)

  const at = block.search(/^ {4}paths:$/m)
  if (at === -1) return []

  const paths = []
  for (const line of block.slice(at).split('\n').slice(1)) {
    const entry = line.match(/^ {6}- ["']?([^"'\s]+)["']?\s*$/)
    if (!entry) break
    paths.push(entry[1])
  }
  return paths
}

// Whether a producer path covers a consumer one. Exact match, or a "/**" suffix
// covering everything beneath it, so a broad producer glob still satisfies a
// narrower consumer path. Only "/**" is understood; any other glob is compared
// literally, which can only produce a false failure, never a false pass.
function covers(producerGlob, consumerPath) {
  if (producerGlob === consumerPath) return true
  return producerGlob.endsWith('/**') &&
    consumerPath.startsWith(producerGlob.slice(0, -2))
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

// The invariant the whole design rests on. Narrowing the producer's trigger
// below the consumer's is the original bug: on-pr-nx runs, on-pr-ts-nx does
// not, nx never gets to narrow anything, and every await times out. Tests 1-2
// close the name loop; this closes the trigger loop.
test('on-pr-ts-nx triggers on everything on-pr-nx triggers on', () => {
  const producer = triggerPaths(readFileSync(producerPath, 'utf8'), 'pull_request')
  const consumer = triggerPaths(
    readFileSync(join(workflows, 'on-pr-nx.yml'), 'utf8'),
    'pull_request_target'
  )

  assert.ok(producer, 'on-pr-ts-nx has no pull_request trigger')
  assert.ok(consumer, 'on-pr-nx has no pull_request_target trigger')
  assert.ok(
    consumer.length > 0,
    'on-pr-nx now fires on every path, so on-pr-ts-nx cannot be a superset by paths alone'
  )

  const uncovered = consumer.filter((path) => !producer.some((glob) => covers(glob, path)))
  assert.deepEqual(
    uncovered,
    [],
    'on-pr-nx triggers on these but on-pr-ts-nx does not, so the producer never ' +
      'runs and every await times out:\n  ' + uncovered.join('\n  ')
  )
})
