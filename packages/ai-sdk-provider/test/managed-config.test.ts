import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  synthesizeServeConfig,
  writeEphemeralConfig
} from '../src/managed/config-synthesizer.js'
import { UnknownManagedModelError } from '../src/managed/errors.js'

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
