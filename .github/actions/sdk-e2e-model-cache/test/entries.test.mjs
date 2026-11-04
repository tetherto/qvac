import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cacheKey,
  cachePaths,
  contentIdFor,
  firstChecksumMismatch,
  isComplete,
  mapWithConcurrency,
  unplannedPaths,
  validatePlan
} from '../src/entries.mjs'

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cache-'))
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    fs.writeFileSync(path.join(dir, relative), content)
  }
  return dir
}

const sha = (text) => createHash('sha256').update(text).digest('hex')
const root = 'c'
const single = {
  contentId: sha('abcd'),
  paths: [`${root}/0123_m.gguf`],
  files: [{ path: `${root}/0123_m.gguf`, size: 4, sha256: sha('abcd') }],
  expectedSize: 4,
  models: ['M'],
  owners: ['m']
}
const set = {
  contentId: sha(['/a.bin:' + sha('aa'), '/b.mlmodelc/weight.bin:' + sha('bbb')].join('\n')),
  paths: [`${root}/sets/s1`],
  files: [
    { path: `${root}/sets/s1/a.bin`, size: 2, sha256: sha('aa') },
    { path: `${root}/sets/s1/b.mlmodelc/weight.bin`, size: 3, sha256: sha('bbb') }
  ],
  expectedSize: 5,
  models: ['S'],
  owners: ['s']
}

test('the key is the content id; the archive is the exact file list', () => {
  assert.equal(cacheKey('pfx', single), `pfx-${sha('abcd')}`)
  assert.deepEqual(cachePaths(single), ['c/0123_m.gguf'])
  assert.deepEqual(cachePaths(set), ['c/sets/s1/a.bin', 'c/sets/s1/b.mlmodelc/weight.bin'])
})

test('the key is recomputed from the files, so a plan cannot borrow another model key', () => {
  assert.equal(contentIdFor(single), single.contentId)
  assert.equal(contentIdFor(set), set.contentId)
  assert.equal(
    contentIdFor({ ...set, files: [...set.files].reverse() }),
    set.contentId,
    'order of listing does not matter'
  )
  const plan = (entry) => ({ version: 1, cacheRoot: root, entries: [entry], unresolved: [] })
  assert.throws(() => validatePlan(plan({ ...single, contentId: sha('other') })), /does not match/)
  const swapped = { ...set, files: [{ ...set.files[0], sha256: sha('evil') }, set.files[1]] }
  assert.throws(() => validatePlan(plan(swapped)), /does not match/)
  assert.throws(
    () => validatePlan(plan({ ...set, files: [{ ...set.files[0], path: 'c/sets/s2/a.bin' }] })),
    /inside its directory/
  )
  assert.throws(() => validatePlan(plan({ ...single, paths: ['c/a', 'c/b'] })), /exactly one path/)
})

test('complete means every pinned file at its exact size', () => {
  assert.equal(isComplete(single, workspace({ 'c/0123_m.gguf': 'abcd' })), true)
  assert.equal(isComplete(single, workspace({ 'c/0123_m.gguf': 'abc' })), false)
  assert.equal(isComplete(single, workspace({})), false)

  const full = { 'c/sets/s1/a.bin': 'aa', 'c/sets/s1/b.mlmodelc/weight.bin': 'bbb' }
  assert.equal(isComplete(set, workspace({ ...full, 'c/sets/s1/extra': 'x' })), true)
  assert.equal(isComplete(set, workspace({ 'c/sets/s1/a.bin': 'aaaaa' })), false, 'bytes alone')
  assert.equal(
    isComplete(set, workspace({ ...full, 'c/sets/s1/b.mlmodelc/weight.bin': 'bb' })),
    false
  )
})

test('a save only takes registry content', async () => {
  const good = workspace({ 'c/sets/s1/a.bin': 'aa', 'c/sets/s1/b.mlmodelc/weight.bin': 'bbb' })
  const bad = workspace({ 'c/sets/s1/a.bin': 'aa', 'c/sets/s1/b.mlmodelc/weight.bin': 'bbX' })
  assert.equal(await firstChecksumMismatch(set, good), undefined)
  assert.equal(await firstChecksumMismatch(set, bad), 'c/sets/s1/b.mlmodelc/weight.bin')
})

test('a plan that would key or write outside its contract is rejected', () => {
  const plan = (entry, cacheRoot = root) => ({
    version: 1,
    cacheRoot,
    entries: [entry],
    unresolved: []
  })
  assert.doesNotThrow(() => validatePlan(plan(single)))
  assert.doesNotThrow(() => validatePlan(plan(set)))
  assert.throws(() => validatePlan({ version: 2, entries: [] }), /version 1/)
  assert.throws(() => validatePlan({ ...plan(single), unresolved: undefined }), /unresolved/)
  assert.throws(() => validatePlan(plan({ ...single, contentId: 'x y' })), /contentId/)
  assert.throws(() => validatePlan(plan({ ...single, paths: ['c/../../etc/x'] })), /not inside/)
  assert.throws(() => validatePlan(plan({ ...single, paths: ['/etc/x'] })), /not inside/)
  assert.throws(
    () =>
      validatePlan(
        plan({ ...single, files: [{ path: 'elsewhere/x', size: 1, sha256: sha('x') }] })
      ),
    /not inside/
  )
  assert.throws(
    () => validatePlan(plan({ ...single, files: [{ path: 'c/x', size: 1, sha256: 'nope' }] })),
    /sha256/
  )
  assert.throws(() => validatePlan(plan({ ...single, files: [] })), /files are required/)
  assert.throws(() => validatePlan(plan(single, '/abs')), /cacheRoot/)
})

test('drift lists cache items no entry covers, but not dotfiles or shards', () => {
  const cwd = workspace({
    'c/0123_m.gguf': 'abcd',
    'c/9999_other.gguf': 'x',
    'c/.lock': '',
    'c/sets/s1/a.bin': 'aa',
    'c/sets/ffff/q.gguf': 'q',
    'c/sharded/eeee/s-00001.gguf': 's'
  })
  const plan = { cacheRoot: root, entries: [single, set] }
  assert.deepEqual(unplannedPaths(plan, cwd), [
    'c/9999_other.gguf',
    'c/sets/ffff'
  ])
})

test('mapWithConcurrency keeps order and caps parallelism', async () => {
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return value * 10
  })
  assert.deepEqual(results, [10, 20, 30, 40, 50])
  assert.equal(peak, 2)
})
