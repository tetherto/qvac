import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHARED_RUNTIME_LIBS,
  buildConsumerManifest,
  collectResolvedVersions,
  findDuplicates,
  formatDuplicates,
  formatResolved,
} from '../lib/shared-runtime-libs.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function lockfile(packages) {
  return { lockfileVersion: 3, packages: { '': { name: 'consumer' }, ...packages } }
}

const singleCopy = lockfile({
  'node_modules/@qvac/inference': { version: '0.20.0' },
  'node_modules/@qvac/decoder-audio': { version: '0.6.0' },
  'node_modules/@qvac/infer-base': { version: '0.6.2' },
  'node_modules/@qvac/logging': { version: '0.1.1' },
  'node_modules/@qvac/error': { version: '0.1.1' },
})

const nestedInferBase = lockfile({
  'node_modules/@qvac/inference': { version: '0.20.0' },
  'node_modules/@qvac/decoder-audio': { version: '0.5.0' },
  'node_modules/@qvac/decoder-audio/node_modules/@qvac/infer-base': { version: '0.4.2' },
  'node_modules/@qvac/infer-base': { version: '0.6.2' },
  'node_modules/@qvac/logging': { version: '0.1.1' },
  'node_modules/@qvac/error': { version: '0.1.1' },
})

test('checks infer-base, logging and error', () => {
  assert.deepEqual(SHARED_RUNTIME_LIBS, ['@qvac/infer-base', '@qvac/logging', '@qvac/error'])
})

test('consumer manifest installs the package and every peer', () => {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'packages/inference/package.json'), 'utf8'))
  const manifest = buildConsumerManifest(pkg, 'file:./package.tgz')

  assert.equal(manifest.dependencies['@qvac/inference'], 'file:./package.tgz')
  for (const [peer, range] of Object.entries(pkg.peerDependencies)) {
    assert.equal(manifest.dependencies[peer], range, peer)
  }
  assert.equal(Object.keys(manifest.dependencies).length, Object.keys(pkg.peerDependencies).length + 1)
})

test('consumer manifest works without peers', () => {
  const manifest = buildConsumerManifest({ name: '@qvac/x' }, '1.0.0')
  assert.deepEqual(manifest.dependencies, { '@qvac/x': '1.0.0' })
})

test('one copy of each lib passes', () => {
  const resolved = collectResolvedVersions(singleCopy)
  assert.deepEqual(findDuplicates(resolved), [])
  assert.deepEqual(formatResolved(resolved), [
    '@qvac/infer-base: 0.6.2',
    '@qvac/logging: 0.1.1',
    '@qvac/error: 0.1.1',
  ])
})

test('a nested second copy fails and names the peer that pulls it', () => {
  const duplicates = findDuplicates(collectResolvedVersions(nestedInferBase))

  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].lib, '@qvac/infer-base')
  assert.deepEqual(formatDuplicates(duplicates), [
    '@qvac/infer-base resolves to 2 versions: 0.4.2 (@qvac/decoder-audio@0.5.0); 0.6.2 (hoisted)',
  ])
})

test('duplicates in logging and error are caught too', () => {
  const resolved = collectResolvedVersions(
    lockfile({
      'node_modules/@qvac/logging': { version: '0.2.0' },
      'node_modules/@qvac/llm-llamacpp/node_modules/@qvac/logging': { version: '0.1.1' },
      'node_modules/@qvac/error': { version: '0.2.0' },
      'node_modules/@qvac/tts-ggml/node_modules/@qvac/error': { version: '0.1.1' },
    }),
  )
  assert.deepEqual(
    findDuplicates(resolved).map(({ lib }) => lib),
    ['@qvac/logging', '@qvac/error'],
  )
})

test('two nested copies of the same version count once', () => {
  const resolved = collectResolvedVersions(
    lockfile({
      'node_modules/@qvac/a/node_modules/@qvac/infer-base': { version: '0.4.2' },
      'node_modules/@qvac/b/node_modules/@qvac/infer-base': { version: '0.4.2' },
    }),
  )
  assert.deepEqual(findDuplicates(resolved), [])
  assert.deepEqual(resolved.get('@qvac/infer-base').get('0.4.2'), ['@qvac/a', '@qvac/b'])
})

test('packages whose name only ends with a lib name are ignored', () => {
  const resolved = collectResolvedVersions(
    lockfile({
      'node_modules/@qvac/infer-base': { version: '0.6.2' },
      'node_modules/@other/infer-base': { version: '9.9.9' },
    }),
  )
  assert.deepEqual(findDuplicates(resolved), [])
})

test('a lib that is not installed is reported, not treated as a duplicate', () => {
  const resolved = collectResolvedVersions(lockfile({}))
  assert.deepEqual(findDuplicates(resolved), [])
  assert.equal(formatResolved(resolved)[0], '@qvac/infer-base: not installed')
})

test('rejects a v1 lockfile', () => {
  assert.throws(() => collectResolvedVersions({ lockfileVersion: 1, dependencies: {} }), /lockfileVersion >= 2/)
})
