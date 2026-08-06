'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  SkipEntryError,
  prepareCoremlEntry,
  buildLabel,
  buildParakeetEnv
} = require('../run-rtf-benchmark-matrix')

const onDarwin = process.platform === 'darwin'

function makeModelsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtf-coreml-'))
  fs.writeFileSync(path.join(dir, 'parakeet-tdt-0.6b-v3.f16.gguf'), 'fake-gguf')
  return dir
}

test('coreml entries get a -coreml label suffix', () => {
  const entry = { engine: 'parakeet', modelType: 'tdt', quant: 'f16', useGPU: true, coreml: true }
  assert.equal(buildLabel('parakeet', entry, 0), '1-tdt-f16-gpu-coreml')
  const plain = { engine: 'parakeet', modelType: 'tdt', quant: 'f16', useGPU: true }
  assert.equal(buildLabel('parakeet', plain, 0), '1-tdt-f16-gpu')
})

test('coreml entries default the backend hint to coreml', () => {
  const env = buildParakeetEnv(
    { modelType: 'tdt', quant: 'f16', useGPU: true, coreml: true },
    'label'
  )
  assert.equal(env.QVAC_PARAKEET_BENCHMARK_BACKEND, 'coreml')
  const hinted = buildParakeetEnv({ modelType: 'tdt', coreml: true, backendHint: 'metal' }, 'label')
  assert.equal(hinted.QVAC_PARAKEET_BENCHMARK_BACKEND, 'metal')
})

test('unsupported model types are a hard failure, not a skip', { skip: !onDarwin }, () => {
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'sortformer', coreml: true }, makeModelsDir()),
    (err) => !(err instanceof SkipEntryError) && /not supported/.test(err.message)
  )
})

test('missing sidecar is a skip, not a failure', { skip: !onDarwin }, () => {
  const modelsDir = makeModelsDir()
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'tdt', quant: 'f16', coreml: true }, modelsDir),
    SkipEntryError
  )
})

test(
  'staged sidecar yields a GGUF link beside it plus the benchmark env',
  { skip: !onDarwin },
  () => {
    const modelsDir = makeModelsDir()
    fs.mkdirSync(path.join(modelsDir, 'coreml', 'parakeet-tdt-0.6b-v3-encoder.mlmodelc'), {
      recursive: true
    })

    const env = prepareCoremlEntry({ modelType: 'tdt', quant: 'f16', coreml: true }, modelsDir)

    const ggufLink = path.join(modelsDir, 'coreml', 'parakeet-tdt-0.6b-v3.f16.gguf')
    assert.equal(env.QVAC_TEST_GGUF_TDT, ggufLink)
    assert.equal(env.QVAC_PARAKEET_BENCHMARK_COREML, 'true')
    assert.equal(fs.readFileSync(ggufLink, 'utf8'), 'fake-gguf')

    const again = prepareCoremlEntry({ modelType: 'tdt', quant: 'f16', coreml: true }, modelsDir)
    assert.equal(again.QVAC_TEST_GGUF_TDT, ggufLink)
  }
)

test('missing staged GGUF next to a present sidecar is a hard failure', { skip: !onDarwin }, () => {
  const modelsDir = makeModelsDir()
  fs.mkdirSync(path.join(modelsDir, 'coreml', 'parakeet-tdt-0.6b-v3-encoder.mlmodelc'), {
    recursive: true
  })
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'tdt', quant: 'q8_0', coreml: true }, modelsDir),
    (err) => !(err instanceof SkipEntryError) && /not staged under models\//.test(err.message)
  )
})

test('ctc is rejected outright, not staged', { skip: !onDarwin }, () => {
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'ctc', quant: 'f16', coreml: true }, makeModelsDir()),
    (err) => !(err instanceof SkipEntryError) && /not supported/.test(err.message)
  )
})
