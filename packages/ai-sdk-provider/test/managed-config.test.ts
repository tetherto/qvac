import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  modelNames,
  synthesizeServeConfig,
  writeEphemeralConfig
} from '../src/managed/config-synthesizer.js'
import {
  DuplicateManagedModelError,
  MultipleDefaultManagedModelsError,
  UnknownManagedModelError
} from '../src/managed/errors.js'

// A real constant from the generated catalog (see src/models/constants.ts).
const KNOWN = 'QWEN3_600M_INST_Q4'

test('synthesizeServeConfig builds a serve.models map keyed by constant name', () => {
  const config = synthesizeServeConfig([KNOWN])

  assert.deepEqual(config, {
    serve: {
      models: {
        [KNOWN]: { model: KNOWN, preload: true, default: true }
      }
    }
  })
})

test('synthesizeServeConfig keys a catalog id by its friendly alias, model = constant', () => {
  // A public models.dev id stays the serve alias, so the serve answers
  // `qwen3.5-9b` directly; `model` resolves to the underlying SDK constant.
  const config = synthesizeServeConfig(['qwen3.5-9b'])

  assert.deepEqual(config, {
    serve: {
      models: {
        'qwen3.5-9b': { model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M', preload: true, default: true }
      }
    }
  })
})

test('synthesizeServeConfig resolves larger catalog ids to SDK constants', () => {
  const config = synthesizeServeConfig(['gpt-oss-20b', 'gemma4-31b'])

  assert.deepEqual(config.serve.models['gpt-oss-20b'], {
    model: 'GPT_OSS_20B_INST_Q4_K_M',
    preload: true,
    default: true
  })
  assert.deepEqual(config.serve.models['gemma4-31b'], {
    model: 'GEMMA4_31B_MULTIMODAL_Q4_K_M',
    preload: true
  })
})

test('synthesizeServeConfig carries per-model config under a catalog-id alias', () => {
  const config = synthesizeServeConfig([
    { name: 'qwen3.5-9b', config: { ctx_size: 32768, reasoning_budget: -1 } }
  ])

  assert.deepEqual(config.serve.models['qwen3.5-9b'], {
    model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
    preload: true,
    default: true,
    config: { ctx_size: 32768, reasoning_budget: -1 }
  })
})

test('synthesizeServeConfig marks only the first model as default', () => {
  // Two known constants; the second one is any other chat/embedding constant.
  const config = synthesizeServeConfig([KNOWN, 'QWEN3_1_7B_INST_Q4'])
  const entries = config.serve.models

  assert.equal(entries[KNOWN]?.default, true)
  assert.equal(entries['QWEN3_1_7B_INST_Q4']?.default, undefined)
  assert.equal(entries['QWEN3_1_7B_INST_Q4']?.preload, true)
})

test('synthesizeServeConfig throws UnknownManagedModelError for an unknown constant', () => {
  assert.throws(
    () => synthesizeServeConfig(['NOT_A_REAL_MODEL']),
    (err: unknown) => {
      assert.ok(err instanceof UnknownManagedModelError)
      assert.equal(err.code, 'UNKNOWN_MODEL')
      assert.deepEqual(err.unknownModels, ['NOT_A_REAL_MODEL'])
      return true
    }
  )
})

test('synthesizeServeConfig reports every unknown constant, not just the first', () => {
  assert.throws(
    () => synthesizeServeConfig([KNOWN, 'NOPE_ONE', 'NOPE_TWO']),
    (err: unknown) => {
      assert.ok(err instanceof UnknownManagedModelError)
      assert.deepEqual(err.unknownModels, ['NOPE_ONE', 'NOPE_TWO'])
      return true
    }
  )
})

test('synthesizeServeConfig rejects an empty model list', () => {
  assert.throws(() => synthesizeServeConfig([]), UnknownManagedModelError)
})

test('synthesizeServeConfig rejects duplicate model names (string or spec)', () => {
  assert.throws(
    () => synthesizeServeConfig([KNOWN, { name: KNOWN, default: true }]),
    (err: unknown) => {
      assert.ok(err instanceof DuplicateManagedModelError)
      assert.equal(err.code, 'DUPLICATE_MODEL')
      assert.deepEqual(err.duplicateModels, [KNOWN])
      return true
    }
  )
})

test('synthesizeServeConfig rejects more than one explicit default', () => {
  assert.throws(
    () =>
      synthesizeServeConfig([
        { name: KNOWN, default: true },
        { name: 'QWEN3_1_7B_INST_Q4', default: true }
      ]),
    (err: unknown) => {
      assert.ok(err instanceof MultipleDefaultManagedModelsError)
      assert.equal(err.code, 'MULTIPLE_DEFAULTS')
      assert.deepEqual(err.defaultModels, [KNOWN, 'QWEN3_1_7B_INST_Q4'])
      return true
    }
  )
})

test('synthesizeServeConfig accepts a spec object and emits its per-model config', () => {
  const config = synthesizeServeConfig([
    { name: KNOWN, config: { ctx_size: 16384, reasoning_budget: 0 } }
  ])

  assert.deepEqual(config.serve.models[KNOWN], {
    model: KNOWN,
    preload: true,
    default: true,
    config: { ctx_size: 16384, reasoning_budget: 0 }
  })
})

test('synthesizeServeConfig honors an explicit preload: false', () => {
  const config = synthesizeServeConfig([{ name: KNOWN, preload: false }])
  assert.equal(config.serve.models[KNOWN]?.preload, false)
})

test('synthesizeServeConfig honors an explicit default on a non-first model', () => {
  const config = synthesizeServeConfig([KNOWN, { name: 'QWEN3_1_7B_INST_Q4', default: true }])
  const entries = config.serve.models

  // The explicit default wins; the first model is NOT auto-defaulted.
  assert.equal(entries['QWEN3_1_7B_INST_Q4']?.default, true)
  assert.equal(entries[KNOWN]?.default, undefined)
})

test('synthesizeServeConfig mixes bare-string and spec-object inputs', () => {
  const config = synthesizeServeConfig([
    KNOWN,
    { name: 'QWEN3_1_7B_INST_Q4', config: { ctx_size: 8192 } }
  ])
  const entries = config.serve.models

  // Bare string => first => default, no config block.
  assert.equal(entries[KNOWN]?.default, true)
  assert.equal(entries[KNOWN]?.config, undefined)
  // Spec object => carries config, not default.
  assert.deepEqual(entries['QWEN3_1_7B_INST_Q4']?.config, { ctx_size: 8192 })
  assert.equal(entries['QWEN3_1_7B_INST_Q4']?.default, undefined)
})

test('synthesizeServeConfig omits the config key when a spec has no config', () => {
  const config = synthesizeServeConfig([{ name: KNOWN }])
  assert.ok(!('config' in config.serve.models[KNOWN]!))
})

test('synthesizeServeConfig validates names inside spec objects', () => {
  assert.throws(
    () => synthesizeServeConfig([{ name: 'NOT_A_REAL_MODEL', config: { ctx_size: 1 } }]),
    (err: unknown) => {
      assert.ok(err instanceof UnknownManagedModelError)
      assert.deepEqual(err.unknownModels, ['NOT_A_REAL_MODEL'])
      return true
    }
  )
})

test('modelNames extracts alias names from mixed inputs in order', () => {
  assert.deepEqual(
    modelNames([KNOWN, { name: 'QWEN3_1_7B_INST_Q4', config: { ctx_size: 8192 } }]),
    [KNOWN, 'QWEN3_1_7B_INST_Q4']
  )
})

test('writeEphemeralConfig writes valid JSON and cleanup removes it', async () => {
  const { configPath, cleanup } = await writeEphemeralConfig([KNOWN])

  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.serve.models[KNOWN].model, KNOWN)
  assert.equal(parsed.serve.models[KNOWN].preload, true)

  await cleanup()
  await assert.rejects(readFile(configPath, 'utf8'), /ENOENT/)

  // cleanup is idempotent — a second call must not throw.
  await cleanup()
})

test('writeEphemeralConfig persists a per-model config block', async () => {
  const { configPath, cleanup } = await writeEphemeralConfig([
    { name: KNOWN, config: { ctx_size: 16384, reasoning_budget: 0 } }
  ])

  const parsed = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(parsed.serve.models[KNOWN].config, {
    ctx_size: 16384,
    reasoning_budget: 0
  })

  await cleanup()
})
