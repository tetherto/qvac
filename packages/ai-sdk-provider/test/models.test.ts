import assert from 'node:assert/strict'
import test from 'node:test'

import * as packageRoot from '../src/index.js'
import { allModels } from '../src/models/constants.js'
import type { EndpointCategory, ModelConstant } from '../src/models/types.js'

const ENDPOINT_CATEGORIES: ReadonlyArray<EndpointCategory> = [
  'chat',
  'embedding',
  'transcription',
  'audio-translation',
  'translation',
  'speech',
  'ocr',
  'image'
]

test('allModels is exported as an array (placeholder ships empty)', () => {
  assert.ok(Array.isArray(allModels), 'allModels should be an array')
})

test('every entry in allModels (if any) satisfies the ModelConstant shape', () => {
  for (const m of allModels) {
    assert.equal(typeof m.name, 'string')
    assert.equal(typeof m.src, 'string')
    assert.equal(typeof m.addon, 'string')
    assert.equal(typeof m.engine, 'string')
    assert.equal(typeof m.expectedSize, 'number')
    assert.ok(
      ENDPOINT_CATEGORIES.includes(m.endpointCategory),
      `endpointCategory "${m.endpointCategory}" not in known set`
    )
  }
})

test('the package re-exports model metadata at the top level', () => {
  assert.ok('allModels' in packageRoot, 'top-level should re-export allModels')
  assert.ok('models' in packageRoot, 'top-level should re-export the models namespace')
  assert.ok(Array.isArray(packageRoot.allModels))
})

test('the `models` namespace contains the codegen exports', () => {
  // The placeholder constants.ts ships only `allModels`. Post-codegen this
  // namespace gains one named export per model constant; the assertion stays
  // valid because `allModels` is always present.
  assert.ok('allModels' in packageRoot.models, 'models namespace should include allModels')
})

test('ModelConstant<TEndpoint> narrows the endpoint at the type level (compile-time only)', () => {
  // This is a type-only assertion — if the file compiles, the narrowing works.
  // Runtime body asserts nothing beyond "the value matches the literal type".
  const chatModel: ModelConstant<'chat'> = {
    name: 'TEST_CHAT',
    src: 'TEST_CHAT',
    registryPath: 'test/path',
    registrySource: 'hf',
    blobCoreKey: '0'.repeat(64),
    blobBlockOffset: 0,
    blobBlockLength: 0,
    blobByteOffset: 0,
    modelId: 'test.gguf',
    expectedSize: 0,
    sha256Checksum: '0'.repeat(64),
    addon: 'llamacpp-completion',
    engine: 'llamacpp-completion',
    endpointCategory: 'chat'
  }
  assert.equal(chatModel.endpointCategory, 'chat')
})
