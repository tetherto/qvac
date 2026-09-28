import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectAddonFabric,
  findFabricConflict,
  formatConflict,
  sdkQvacDependencies,
} from '../lib/sdk-fabric-agreement.mjs'

function lockfile(packages) {
  return { lockfileVersion: 3, packages: { '': { name: 'consumer' }, ...packages } }
}

function addon(version, fabric) {
  return fabric ? { version, dependencies: { '@qvac/fabric': fabric } } : { version, dependencies: {} }
}

const sdk = { 'node_modules/@qvac/sdk': { version: '0.20.1' } }
const deps = ['@qvac/asr-ggml', '@qvac/llm-llamacpp', '@qvac/translation-nmtcpp']

test('sdkQvacDependencies keeps direct and optional @qvac deps only', () => {
  const pkg = {
    dependencies: { '@qvac/llm-llamacpp': '^0.54.0', zod: '^3.0.0' },
    optionalDependencies: { '@qvac/tts-ggml': '^0.9.1' },
    devDependencies: { '@qvac/test-suite': '^0.1.0' },
  }
  assert.deepEqual(sdkQvacDependencies(pkg), ['@qvac/llm-llamacpp', '@qvac/tts-ggml'])
})

test('agreeing addons pass and addons without fabric are skipped', () => {
  const lock = lockfile({
    ...sdk,
    'node_modules/@qvac/asr-ggml': addon('0.5.3'),
    'node_modules/@qvac/llm-llamacpp': addon('0.54.0', '^0.17.0'),
    'node_modules/@qvac/translation-nmtcpp': addon('0.17.1', '^0.17.0'),
    'node_modules/@qvac/fabric': { version: '0.17.0' },
  })
  const addons = collectAddonFabric(lock, '@qvac/sdk', deps)
  assert.deepEqual(
    addons.map(({ name }) => name),
    ['@qvac/llm-llamacpp', '@qvac/translation-nmtcpp'],
  )
  assert.deepEqual(findFabricConflict(addons), [])
})

test('a mixed set names the packages and fabric versions', () => {
  const lock = lockfile({
    ...sdk,
    'node_modules/@qvac/asr-ggml': addon('0.5.3'),
    'node_modules/@qvac/llm-llamacpp': addon('0.54.0', '^0.17.0'),
    'node_modules/@qvac/fabric': { version: '0.17.0' },
    'node_modules/@qvac/translation-nmtcpp': addon('0.16.1', '^0.15.0'),
    'node_modules/@qvac/translation-nmtcpp/node_modules/@qvac/fabric': { version: '0.15.0' },
  })
  const conflict = findFabricConflict(collectAddonFabric(lock, '@qvac/sdk', deps))
  assert.deepEqual(formatConflict(conflict), [
    '@qvac/fabric 0.17.0: @qvac/llm-llamacpp@0.54.0 (^0.17.0)',
    '@qvac/fabric 0.15.0: @qvac/translation-nmtcpp@0.16.1 (^0.15.0)',
  ])
})

test('an addon nested under the SDK resolves before the hoisted copy', () => {
  const lock = lockfile({
    ...sdk,
    'node_modules/@qvac/llm-llamacpp': addon('0.40.0', '^0.12.0'),
    'node_modules/@qvac/sdk/node_modules/@qvac/llm-llamacpp': addon('0.54.0', '^0.17.0'),
    'node_modules/@qvac/sdk/node_modules/@qvac/fabric': { version: '0.17.0' },
    'node_modules/@qvac/fabric': { version: '0.12.0' },
  })
  assert.deepEqual(collectAddonFabric(lock, '@qvac/sdk', ['@qvac/llm-llamacpp']), [
    { name: '@qvac/llm-llamacpp', version: '0.54.0', range: '^0.17.0', fabric: '0.17.0' },
  ])
})

test('a declared but unresolved fabric throws', () => {
  const lock = lockfile({ ...sdk, 'node_modules/@qvac/llm-llamacpp': addon('0.54.0', '^0.17.0') })
  assert.throws(() => collectAddonFabric(lock, '@qvac/sdk', ['@qvac/llm-llamacpp']), /did not resolve/)
})

test('rejects lockfiles older than v2', () => {
  assert.throws(() => collectAddonFabric({ lockfileVersion: 1, packages: {} }, '@qvac/sdk', []), /lockfileVersion/)
})
