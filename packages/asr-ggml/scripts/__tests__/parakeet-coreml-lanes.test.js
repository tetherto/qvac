'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  addUnifiedCoverage,
  buildLabel,
  buildParakeetEnv,
  prepareCoremlEntry,
  SkipEntryError
} = require('../run-rtf-benchmark-matrix.js')

const STEM = 'parakeet-tdt-0.6b-v3'
const isDarwin = process.platform === 'darwin'

// Build a throwaway models/ tree. `sidecar` / `gguf` control which of the two
// artifacts a coreml lane depends on are present, so each test can exercise one
// missing-piece path in isolation.
function makeModelsDir({ sidecar = true, gguf = true, quant = 'f16' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-coreml-'))
  if (gguf) fs.writeFileSync(path.join(dir, `${STEM}.${quant}.gguf`), 'gguf')
  if (sidecar)
    fs.mkdirSync(path.join(dir, 'coreml', `${STEM}-encoder.mlmodelc`), { recursive: true })
  else fs.mkdirSync(path.join(dir, 'coreml'), { recursive: true })
  return dir
}

test('coreml lanes get a distinct label so they cannot overwrite the metal artifact', () => {
  const entry = { engine: 'parakeet', modelType: 'tdt', quant: 'f16', useGPU: true }
  const metal = buildLabel('parakeet', entry, 0)
  const coreml = buildLabel('parakeet', { ...entry, coreml: true }, 0)

  assert.equal(metal, '1-tdt-f16-gpu')
  assert.equal(coreml, '1-tdt-f16-gpu-coreml')
  assert.notEqual(metal, coreml)
})

test('an explicit backendHint still wins over the coreml default', () => {
  const env = buildParakeetEnv(
    { engine: 'parakeet', modelType: 'tdt', coreml: true, backendHint: 'metal' },
    'l'
  )
  assert.equal(env.QVAC_PARAKEET_BENCHMARK_BACKEND, 'metal')
})

test('a coreml entry defaults its backend hint to coreml', () => {
  const env = buildParakeetEnv({ engine: 'parakeet', modelType: 'tdt', coreml: true }, 'l')
  assert.equal(env.QVAC_PARAKEET_BENCHMARK_BACKEND, 'coreml')
})

test('a plain entry never claims coreml', () => {
  const env = buildParakeetEnv({ engine: 'parakeet', modelType: 'tdt', useGPU: true }, 'l')
  assert.notEqual(env.QVAC_PARAKEET_BENCHMARK_BACKEND, 'coreml')
  assert.equal(env.QVAC_PARAKEET_BENCHMARK_COREML, undefined)
})

test('addUnifiedCoverage does not clone a coreml lane into a unified one', () => {
  // `unified` is a different checkpoint family with no encoder sidecar, so a
  // cloned coreml entry would hard-fail the matrix.
  const entries = [{ engine: 'parakeet', modelType: 'tdt', quant: 'f16', coreml: true }]
  assert.deepEqual(addUnifiedCoverage(entries), entries)
})

test('addUnifiedCoverage still clones plain tdt entries alongside a coreml one', () => {
  const plain = { engine: 'parakeet', modelType: 'tdt', quant: 'f16', useGPU: true }
  const coreml = { ...plain, coreml: true }
  const expanded = addUnifiedCoverage([plain, coreml])

  assert.equal(expanded.length, 3)
  assert.deepEqual(expanded[2], { ...plain, modelType: 'unified' })
  assert.ok(!expanded.some((e) => e.modelType === 'unified' && e.coreml))
})

test('an unsupported model type is a hard failure on every platform', () => {
  const dir = makeModelsDir()
  // ctc / sortformer have no validated sidecar: claiming coreml for them is a
  // configuration error, and skipping would hide it. It is a property of the
  // matrix entry, not of the runner, so it must be rejected off darwin too --
  // otherwise a typo would only ever surface on the macOS lane.
  for (const modelType of ['ctc', 'sortformer']) {
    assert.throws(
      () => prepareCoremlEntry({ modelType, quant: 'f16' }, dir),
      (err) => !(err instanceof SkipEntryError) && /not supported/.test(err.message),
      `${modelType} must hard-fail`
    )
  }
})

test(
  'a dangling link from an earlier run is replaced, not written through',
  { skip: !isDarwin },
  () => {
    const dir = makeModelsDir()
    const linked = path.join(dir, 'coreml', `${STEM}.f16.gguf`)
    const source = path.join(dir, `${STEM}.f16.gguf`)

    // A link left pointing at a target that is not there yet: existsSync() reads
    // false while the path is still occupied.
    fs.symlinkSync(path.join('..', 'not-yet-restored.gguf'), linked)
    assert.equal(fs.existsSync(linked), false, 'precondition: link is dangling')

    prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir)

    assert.ok(fs.existsSync(linked), 'link now resolves')
    assert.equal(fs.readFileSync(linked, 'utf8'), 'gguf')
    // The source must be untouched — a copy through the dangling link would have
    // clobbered it.
    assert.equal(fs.readFileSync(source, 'utf8'), 'gguf')
  }
)

test(
  'a missing sidecar skips the lane instead of reddening the matrix',
  { skip: !isDarwin },
  () => {
    const dir = makeModelsDir({ sidecar: false })
    assert.throws(
      () => prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir),
      (err) => err instanceof SkipEntryError && /no Core ML encoder sidecar/.test(err.message)
    )
  }
)

test('a missing GGUF beside a staged sidecar is a hard failure', { skip: !isDarwin }, () => {
  const dir = makeModelsDir({ gguf: false })
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir),
    (err) => !(err instanceof SkipEntryError) && /not staged under models\//.test(err.message)
  )
})

test('a staged sidecar pins resolution beside itself, idempotently', { skip: !isDarwin }, () => {
  const dir = makeModelsDir()
  const expected = path.join(dir, 'coreml', `${STEM}.f16.gguf`)

  const env = prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir)

  assert.equal(env.QVAC_TEST_GGUF_TDT, expected)
  assert.equal(env.QVAC_PARAKEET_BENCHMARK_COREML, 'true')
  assert.ok(fs.existsSync(expected), 'GGUF is linked next to the sidecar')
  // The linked GGUF must sit beside the sidecar, not in models/ -- that
  // separation is what stops the cpu/metal lanes seeing the sidecar at all.
  assert.equal(path.dirname(env.QVAC_TEST_GGUF_TDT), path.join(dir, 'coreml'))

  assert.deepEqual(prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir), env)
})

test('coreml lanes are darwin-only', { skip: isDarwin }, () => {
  const dir = makeModelsDir()
  assert.throws(
    () => prepareCoremlEntry({ modelType: 'tdt', quant: 'f16' }, dir),
    (err) => err instanceof SkipEntryError && /darwin/.test(err.message)
  )
})
