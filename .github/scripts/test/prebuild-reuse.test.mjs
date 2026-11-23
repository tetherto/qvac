import assert from 'node:assert/strict'
import test from 'node:test'

import { legKey, NATIVE } from '../prebuild-reuse.mjs'

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
  'packages/llm-llamacpp/web/source-lock.json'
]

test('browser engine inputs participate in native prebuild reuse keys', () => {
  for (const input of inputs) assert.match(input, NATIVE)

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
