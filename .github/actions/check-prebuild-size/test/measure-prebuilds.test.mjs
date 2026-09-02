import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BYTES_PER_MB,
  bytesByTarget,
  collectFiles,
  exceedsLimit,
  formatMb,
  largestFiles,
  measure,
  parseLimitMb,
  renderReport,
  totalBytes
} from '../measure-prebuilds.mjs'

function makeTree (layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuild-size-'))
  for (const [relativePath, bytes] of Object.entries(layout)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, Buffer.alloc(bytes))
  }
  return root
}

test('collectFiles walks nested directories and records relative paths', () => {
  const root = makeTree({
    'linux-x64/mod/a.so': 10,
    'linux-x64/mod/b.so': 20,
    'darwin-arm64/mod/c.dylib': 30
  })

  const files = collectFiles(root)

  assert.equal(files.length, 3)
  assert.deepEqual(
    files.map((file) => file.relativePath).sort(),
    ['darwin-arm64/mod/c.dylib', 'linux-x64/mod/a.so', 'linux-x64/mod/b.so']
  )
  assert.equal(totalBytes(files), 60)
})

test('collectFiles counts a symlink as zero rather than following it', () => {
  const root = makeTree({ 'linux-x64/real.so': 100 })
  fs.symlinkSync(path.join(root, 'linux-x64/real.so'), path.join(root, 'linux-x64/link.so'))

  const files = collectFiles(root)

  assert.equal(files.length, 2)
  assert.equal(totalBytes(files), 100)
})

test('collectFiles returns nothing for an empty tree', () => {
  const root = makeTree({})

  assert.deepEqual(collectFiles(root), [])
  assert.equal(totalBytes([]), 0)
})

test('bytesByTarget subtotals by the first path segment, largest first', () => {
  const files = [
    { relativePath: 'linux-x64/a.so', bytes: 5 },
    { relativePath: 'linux-x64/b.so', bytes: 15 },
    { relativePath: 'win32-x64/c.dll', bytes: 8 }
  ]

  assert.deepEqual(bytesByTarget(files), [
    { target: 'linux-x64', bytes: 20 },
    { target: 'win32-x64', bytes: 8 }
  ])
})

test('largestFiles orders by size and honours the requested count', () => {
  const files = [
    { relativePath: 'a', bytes: 1 },
    { relativePath: 'b', bytes: 3 },
    { relativePath: 'c', bytes: 2 }
  ]

  assert.deepEqual(largestFiles(files, 2).map((file) => file.relativePath), ['b', 'c'])
})

test('largestFiles does not mutate its input', () => {
  const files = [
    { relativePath: 'a', bytes: 1 },
    { relativePath: 'b', bytes: 3 }
  ]

  largestFiles(files, 2)

  assert.deepEqual(files.map((file) => file.relativePath), ['a', 'b'])
})

test('formatMb reports decimal megabytes to one place', () => {
  assert.equal(formatMb(174_828_360), '174.8 MB')
  assert.equal(formatMb(0), '0.0 MB')
})

test('exceedsLimit compares against decimal megabytes', () => {
  assert.equal(exceedsLimit(400 * BYTES_PER_MB, 500), false)
  assert.equal(exceedsLimit(500 * BYTES_PER_MB, 500), false)
  assert.equal(exceedsLimit(500 * BYTES_PER_MB + 1, 500), true)
})

test('exceedsLimit never fails when no limit is configured', () => {
  assert.equal(exceedsLimit(10_000 * BYTES_PER_MB, null), false)
})

test('parseLimitMb treats empty and missing values as no limit', () => {
  assert.equal(parseLimitMb(''), null)
  assert.equal(parseLimitMb('   '), null)
  assert.equal(parseLimitMb(undefined), null)
  assert.equal(parseLimitMb(null), null)
})

test('parseLimitMb accepts positive numbers and rejects anything else', () => {
  assert.equal(parseLimitMb('480'), 480)
  assert.equal(parseLimitMb('480.5'), 480.5)
  assert.throws(() => parseLimitMb('0'), /positive number/)
  assert.throws(() => parseLimitMb('-1'), /positive number/)
  assert.throws(() => parseLimitMb('abc'), /positive number/)
})

test('measure summarises a tree end to end', () => {
  const root = makeTree({
    'linux-x64/mod/cuda.so': 300,
    'linux-x64/mod/vulkan.so': 200,
    'linux-arm64/mod/vulkan.so': 100
  })

  const measurement = measure(root, { topCount: 2 })

  assert.equal(measurement.fileCount, 3)
  assert.equal(measurement.bytes, 600)
  assert.deepEqual(measurement.byTarget, [
    { target: 'linux-x64', bytes: 500 },
    { target: 'linux-arm64', bytes: 100 }
  ])
  assert.deepEqual(measurement.largest.map((file) => file.bytes), [300, 200])
})

test('renderReport states the limit and lists targets', () => {
  const measurement = measure(makeTree({ 'linux-x64/a.so': 2 * BYTES_PER_MB }))

  const report = renderReport(measurement, 480)

  assert.match(report, /Total: \*\*2\.0 MB\*\* across 1 files/)
  assert.match(report, /Limit: 480\.0 MB\./)
  assert.match(report, /\| `linux-x64` \| 2\.0 MB \|/)
})

test('renderReport says so when no limit is configured', () => {
  const measurement = measure(makeTree({ 'linux-x64/a.so': 1 }))

  assert.match(renderReport(measurement, null), /No limit configured \(reporting only\)\./)
})
