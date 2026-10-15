import assert from 'node:assert/strict'
import test from 'node:test'

import type { QVACModelEntry } from '@qvac/registry-client'

import { processRegistryModel } from '../models/update-models/processing.ts'
import { resolveCanonicalEngine } from '../models/update-models/schemas.ts'

function registryEntry(overrides: Partial<QVACModelEntry> & { deprecated?: boolean }) {
  return {
    path: 'qvac_models_compiled/ocr/gguf/easyocr/2026-05-14/latin_g2.gguf',
    source: 's3:///qvac_models_compiled/ocr/gguf/easyocr/2026-05-14/latin_g2.gguf',
    engine: '@qvac/ocr-ggml',
    license: 'Apache-2.0',
    name: 'latin_g2',
    sizeBytes: 1,
    sha256: 'deadbeef',
    blobBinding: { coreKey: 'ab', blockOffset: 0, blockLength: 1, byteOffset: 0, byteLength: 1 },
    ...overrides
  } as QVACModelEntry
}

test('deprecated registry rows are skipped by the codegen', () => {
  const processed = processRegistryModel(registryEntry({ deprecated: true }))
  assert.equal(processed, null)
})

test('live @qvac/ocr-ggml rows resolve to the ggml-ocr engine and ocr addon', () => {
  const processed = processRegistryModel(registryEntry({}))
  assert.ok(processed, 'live GGUF OCR row must not be skipped')
  assert.equal(processed.engine, 'ggml-ocr')
  assert.equal(processed.addon, 'ocr')
})

test('ONNX-era engine names stay resolvable as legacy aliases of ggml-ocr', () => {
  assert.equal(resolveCanonicalEngine('@qvac/ocr-onnx'), 'ggml-ocr')
  assert.equal(resolveCanonicalEngine('onnx-ocr'), 'ggml-ocr')
})

for (const component of [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
]) {
  test(`Core ML bundle component is not a standalone model: ${component}`, () => {
    for (const prefix of ['', 'qvac_models_compiled/ggml/parakeet/']) {
      const processed = processRegistryModel(
        registryEntry({
          path: `${prefix}parakeet-encoder.mlmodelc/${component}`,
          engine: 'parakeet-transcription'
        })
      )
      assert.equal(processed, null)
    }
  })
}

test('Core ML filtering preserves primary models and standalone binary models', () => {
  for (const path of [
    'qvac_models_compiled/ggml/parakeet/parakeet.f16.gguf',
    'qvac_models_compiled/ggml/parakeet/encoder-model.onnx.data',
    'qvac_models_compiled/ggml/parakeet/weights.bin'
  ]) {
    const processed = processRegistryModel(
      registryEntry({ path, engine: 'parakeet-transcription' })
    )
    assert.ok(processed, path)
    assert.equal(processed.registryPath, path)
    assert.equal(processed.addon, 'parakeet')
  }
})
