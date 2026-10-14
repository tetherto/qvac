import assert from 'node:assert/strict'
import test from 'node:test'

import { groupCompanionSets, isCoremlBundleComponent } from '../models/update-models/companions.ts'
import { generateModelsFileContent } from '../models/update-models/codegen.ts'
import { allModels } from '../src/models/constants.ts'
import type { ProcessedModel } from '../models/update-models/types.ts'

const BUNDLE_FILE =
  'qvac_models_compiled/ggml/parakeet/2026-09-28/encoder.mlmodelc/analytics/coremldata.bin'
const GGUF = 'qvac_models_compiled/ggml/parakeet/2026-05-11/parakeet-ctc-0.6b.q8_0.gguf'

function model(registryPath: string): ProcessedModel {
  return {
    registryPath,
    registrySource: 's3',
    modelId: registryPath.split('/').pop() ?? registryPath,
    addon: 'parakeet',
    engine: 'parakeet-transcription',
    modelName: '',
    quantization: '',
    params: '',
    tags: [],
    expectedSize: 1,
    sha256Checksum: 'ab',
    blobCoreKey: 'core',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
}

test('Core ML bundle files are components, not loadable models', () => {
  assert.equal(isCoremlBundleComponent(BUNDLE_FILE), true)
  assert.equal(isCoremlBundleComponent(GGUF), false)

  const [bundle, primary] = groupCompanionSets([model(BUNDLE_FILE), model(GGUF)])
  assert.equal(bundle?.isCompanionOnly, true)
  assert.equal(primary?.isCompanionOnly, undefined)

  const generated = generateModelsFileContent([model(BUNDLE_FILE), model(GGUF)])
  assert.equal(generated.includes('.mlmodelc/'), false)
  assert.equal(generated.includes(GGUF), true)
})

test('the provider catalog has no Core ML bundle components', () => {
  const leaked = allModels.filter((model) => isCoremlBundleComponent(model.registryPath))
  assert.deepEqual(
    leaked.map((model) => model.name),
    []
  )
})
