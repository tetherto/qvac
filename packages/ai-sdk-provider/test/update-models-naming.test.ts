import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { generateExportName } from '../models/update-models/naming.ts'
import * as modelConstants from '../src/models/constants.ts'
import { groupCompanionSets } from '../models/update-models/companions.ts'
import { generateModelsFileContent } from '../models/update-models/codegen.ts'
import { synthesizeServeConfig } from '../src/managed/config-synthesizer.ts'

const { allModels } = modelConstants

const cases = [
  {
    path: 'ggml/nemotron/2026-10-09/Nemotron-3-Diarization.q8_0.gguf',
    quantization: 'q8_0',
    expected: 'PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0'
  },
  ...['f16', 'q4_0', 'q8_0'].map((quantization) => ({
    path: `ggml/parakeet/2026-09-08/nemotron-3.5-asr-streaming-0.6b.${quantization}.gguf`,
    quantization,
    expected: `PARAKEET_NEMOTRON_0_6B_${quantization.toUpperCase()}`
  })),
  {
    path: 'ggml/indic_conformer/2026-08-07/indic-conformer-ctc.f16.gguf',
    quantization: 'f16',
    expected: 'PARAKEET_INDIC_CONFORMER_CTC_F16'
  },
  {
    path: 'ggml/parakeet/2026-05-11/parakeet-ctc-0.6b.q8_0.gguf',
    quantization: 'q8_0',
    expected: 'PARAKEET_CTC_0_6B_Q8_0'
  },
  {
    path: 'ggml/parakeet/parakeet-tdt-0.6b-v3.f16.gguf',
    quantization: 'f16',
    expected: 'PARAKEET_TDT_0_6B_V3_F16'
  },
  {
    path: 'ggml/parakeet/parakeet-eou-120m-v1.f16.gguf',
    quantization: 'f16',
    expected: 'PARAKEET_EOU_120M_V1_F16'
  },
  {
    path: 'qvac/TranscribePsy-250M-EU-sub-gguf/resolve/92460e0a8e7dc20f2fb126198bdd9eebb9ba2dc7/transcribepsy-250m-eu-sub.gguf',
    quantization: 'q8_0',
    expected: 'PARAKEET_TRANSCRIBEPSY_250M_Q8_0'
  },
  {
    path: 'qvac/TranscribePsy-250M-EU-sub-coreml/resolve/929aa4a3df0ec24232fe206dce5e933caf072897/transcribepsy-250m-eu-sub-coreml.gguf',
    quantization: 'q8_0',
    expected: 'PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0'
  },
  {
    path: 'ggml/parakeet/parakeet-unified-en-0.6b.q8_0.gguf',
    quantization: 'q8_0',
    expected: 'PARAKEET_UNIFIED_0_6B_Q8_0'
  },
  {
    path: 'ggml/parakeet/diar_streaming_sortformer_4spk-v2.1.f16.gguf',
    quantization: 'f16',
    expected: 'PARAKEET_SORTFORMER_4SPK_V2_1_F16'
  },
  {
    path: 'parakeet-tdt-0.6b-v3-onnx/nemo128.onnx',
    quantization: 'fp32',
    expected: 'PARAKEET_TDT_PREPROCESSOR_FP32'
  },
  {
    path: 'parakeet-tdt-0.6b-v3-onnx/encoder-model.onnx.data',
    quantization: 'fp32',
    expected: 'PARAKEET_TDT_ENCODER_DATA_FP32'
  }
]

for (const { path, quantization, expected } of cases) {
  test(`Parakeet naming: ${path}`, () => {
    assert.equal(
      generateExportName({
        path: `qvac_models_compiled/${path}`,
        engine: 'parakeet-transcription',
        name: '',
        quantization,
        params: '',
        tags: [],
        usedNames: new Set()
      }),
      expected
    )
  })
}

test('generated Parakeet names match the SDK and work in managed config', () => {
  const sdkModels: Record<string, { registryPath: string; name: string }> = JSON.parse(
    readFileSync(new URL('../../sdk/contract/models.json', import.meta.url), 'utf8')
  )
  const namesByPath = new Map(
    Object.values(sdkModels).map((model) => [model.registryPath, model.name])
  )
  const parakeetModels = allModels.filter((model) => model.addon === 'parakeet')
  assert.ok(parakeetModels.length > 0)

  for (const model of parakeetModels) {
    const sdkName = namesByPath.get(model.registryPath)
    if (/(?:^|\/)[^/]+\.mlmodelc\//.test(model.registryPath)) {
      assert.equal(sdkName, undefined, 'Core ML components are not SDK model constants')
      assert.equal(
        (modelConstants as Record<string, unknown>)[model.name],
        undefined,
        'Core ML components must not be published as standalone provider models'
      )
      continue
    }

    assert.equal(model.name, sdkName, model.registryPath)
    const config = synthesizeServeConfig([model.name])
    assert.equal(config.serve.models[model.name]?.model, sdkName)
  }
})

test('Parakeet Core ML components are excluded from the generated provider catalog', () => {
  const component = {
    registryPath: 'parakeet/encoder.mlmodelc/weights/weight.bin',
    registrySource: 's3',
    modelId: 'weight.bin',
    addon: 'parakeet' as const,
    engine: 'parakeet-transcription' as const,
    modelName: 'encoder',
    tags: [],
    quantization: '',
    params: '',
    expectedSize: 1,
    sha256Checksum: '',
    blobCoreKey: '',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0
  }
  const [processed] = groupCompanionSets([component])
  assert.equal(processed?.isCompanionOnly, true)
  const output = generateModelsFileContent([processed!])
  assert.equal(output.includes(component.registryPath), false, 'bundle components are excluded')
  assert.equal(
    allModels.some((model) => model.registryPath.includes('.mlmodelc/')),
    false
  )
})
