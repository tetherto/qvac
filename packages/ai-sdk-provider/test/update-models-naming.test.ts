import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { generateExportName } from '../models/update-models/naming.ts'
import { allModels } from '../src/models/constants.ts'
import { synthesizeServeConfig } from '../src/managed/config-synthesizer.ts'

const cases = [
  ...['f16', 'q4_0', 'q8_0'].map((quantization) => ({
    path: `ggml/parakeet/2026-09-08/nemotron-3.5-asr-streaming-0.6b.${quantization}.gguf`,
    quantization,
    expected: `PARAKEET_0_6B_${quantization.toUpperCase()}`
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
    assert.equal(model.name, sdkName, model.registryPath)
    const config = synthesizeServeConfig([model.name])
    assert.equal(config.serve.models[model.name]?.model, sdkName)
  }
})
