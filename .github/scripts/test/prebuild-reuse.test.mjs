import assert from 'node:assert/strict'
import test from 'node:test'

import { legKey, WEB } from '../prebuild-reuse.mjs'

const row = {
  slug: 'llm-llamacpp',
  config: 'linux-x64',
  dir: 'packages/llm-llamacpp',
  runner: 'linux-x64',
  providers: []
}

const inputs = [
  'packages/llm-llamacpp/scripts/build-web.mjs',
  'packages/llm-llamacpp/scripts/validate-web-prebuild.mjs',
  'packages/llm-llamacpp/scripts/npm-command.cjs',
  'packages/llm-llamacpp/web/source-lock.json',
  'packages/llm-llamacpp/web/CMakeLists.txt',
  'packages/llm-llamacpp/web/include/qvac-fabric.h',
  'packages/llm-llamacpp/addon/src/js-interface/web/binding.cpp'
]

test('browser engine inputs participate in native prebuild reuse keys', () => {
  for (const input of inputs) assert.match(input, WEB)

  const tree = (paths) => {
    if (paths.includes('packages/llm-llamacpp')) {
      return inputs.map((path) => `base\t${path}`).join('\n')
    }
    return 'shared\tpnpm-lock.yaml'
  }
  const baseline = legKey(row, tree)

  for (const changed of inputs) {
    const changedTree = (paths) => {
      if (paths.includes('packages/llm-llamacpp')) {
        return inputs.map((path) => `${path === changed ? 'changed' : 'base'}\t${path}`).join('\n')
      }
      return 'shared\tpnpm-lock.yaml'
    }
    assert.notEqual(legKey(row, changedTree), baseline, changed)
  }
})

test('browser engine inputs do not invalidate native-only prebuilds', () => {
  const nativeOnlyRow = { ...row, config: 'darwin-arm64' }
  const tree = (paths) => {
    if (paths.includes('packages/llm-llamacpp')) {
      return inputs.map((path) => `base\t${path}`).join('\n')
    }
    return 'shared\tpnpm-lock.yaml'
  }
  const baseline = legKey(nativeOnlyRow, tree)

  for (const changed of inputs) {
    const changedTree = (paths) => {
      if (paths.includes('packages/llm-llamacpp')) {
        return inputs.map((path) => `${path === changed ? 'changed' : 'base'}\t${path}`).join('\n')
      }
      return 'shared\tpnpm-lock.yaml'
    }
    assert.equal(legKey(nativeOnlyRow, changedTree), baseline, changed)
  }
})

test("another addon's web CMake file remains a native prebuild input", () => {
  const otherRow = {
    ...row,
    slug: 'embed-llamacpp',
    dir: 'packages/embed-llamacpp'
  }
  const input = 'packages/embed-llamacpp/web/CMakeLists.txt'
  const tree = (paths) =>
    paths.includes(otherRow.dir) ? `base\t${input}` : 'shared\tpnpm-lock.yaml'
  const changedTree = (paths) =>
    paths.includes(otherRow.dir) ? `changed\t${input}` : 'shared\tpnpm-lock.yaml'

  assert.doesNotMatch(input, WEB)
  assert.notEqual(legKey(otherRow, changedTree), legKey(otherRow, tree))
})
