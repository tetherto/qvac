import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bareDeps,
  findLags,
  formatLag,
  isBehind,
  nearestPackageJson,
  packageJsonsForChangedFiles,
  pinnedMajor,
} from '../lib/bare-majors.mjs'

test('pinned ranges keep their major and floating ranges do not', () => {
  assert.equal(pinnedMajor('^4.2.0'), 4)
  assert.equal(pinnedMajor('~5.2.1'), 5)
  assert.equal(pinnedMajor('5.2.1'), 5)
  assert.equal(pinnedMajor('*'), null)
  assert.equal(pinnedMajor('>=3.0.0'), null)
  assert.equal(pinnedMajor('>1.0.0'), null)
  assert.equal(pinnedMajor('workspace:*'), null)
})

test('a range is behind only when every alternative is an older pinned major', () => {
  assert.equal(isBehind('^4.2.0', '5.0.0'), true)
  assert.equal(isBehind('^5.0.0', '5.0.0'), false)
  assert.equal(isBehind('>=3.0.0', '4.0.1'), false)
  assert.equal(isBehind('*', '6.2.1'), false)
  assert.equal(isBehind('^4.2.0 || ^5.0.0', '5.0.0'), false)
  assert.equal(isBehind('^1.30.3', '1.34.1'), false)
})

test('only dependencies and devDependencies of bare packages are collected', () => {
  const rows = bareDeps({
    dependencies: { 'bare-signals': '^4.2.0', zod: '^4.0.0' },
    devDependencies: { 'bare-module': '^6.2.0' },
    peerDependencies: { 'bare-link': '>=3.0.0' },
    optionalDependencies: { 'bare-fs': '^4.0.0' },
  })
  assert.deepEqual(rows, [
    { section: 'dependencies', name: 'bare-signals', range: '^4.2.0' },
    { section: 'devDependencies', name: 'bare-module', range: '^6.2.0' },
  ])
})

test('findLags reports the npm latest next to the stale range', () => {
  const lags = findLags(
    [{ section: 'dependencies', name: 'bare-subprocess', range: '^5.2.1' }],
    { 'bare-subprocess': '6.2.1' },
  )
  assert.equal(lags.length, 1)
  assert.equal(lags[0].latest, '6.2.1')
  assert.match(formatLag('packages/tts-ggml/package.json', lags[0]), /bare-subprocess@\^5\.2\.1 is behind 6\.2\.1/)
})

test('a changed file maps to the nearest package.json, including nested packages', () => {
  const manifests = new Set([
    'package.json',
    'packages/sdk/package.json',
    'packages/asr-ggml/package.json',
    'packages/asr-ggml/benchmarks/server/package.json',
    'plugins/opencode/package.json',
  ])
  const has = (path) => manifests.has(path)
  assert.equal(
    nearestPackageJson('packages/sdk/src/worker/lifecycle.ts', has),
    'packages/sdk/package.json',
  )
  assert.equal(
    nearestPackageJson('packages/asr-ggml/benchmarks/server/index.js', has),
    'packages/asr-ggml/benchmarks/server/package.json',
  )
  assert.equal(
    nearestPackageJson('packages/asr-ggml/index.js', has),
    'packages/asr-ggml/package.json',
  )
  assert.equal(nearestPackageJson('docs/gitflow.md', has), 'package.json')
  assert.deepEqual(
    packageJsonsForChangedFiles(
      ['plugins/opencode/index.js', 'plugins/opencode/package.json', 'README.md'],
      has,
    ).sort(),
    ['package.json', 'plugins/opencode/package.json'],
  )
})
