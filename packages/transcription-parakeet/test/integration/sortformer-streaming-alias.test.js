'use strict'

// Direct signal for the MODEL_TYPE_ALIASES resolution added for the
// Sortformer-Streaming (v2.1) benchmark work. The kebab token
// `sortformer-streaming` must resolve to the same MODEL_CONFIGS entry and the
// same QVAC_TEST_GGUF_* env-key as the canonical `sortformerStreaming` key —
// otherwise the desktop RTF matrix / mobile perf tests silently fail to resolve
// the v2.1 GGUF. Every other consumer is an integration test that skips when no
// GGUF is staged, so without this the alias path could break unnoticed.
//
// Lives under test/integration (not test/unit) because it imports helpers.js,
// which eagerly loads the native addon via binding.js (`require.addon()`); the
// unit-test job runs without a prebuild. The GGUF itself is faked with a small
// sentinel file wired through the QVAC_TEST_GGUF_<TYPE> override, so this test
// needs neither a real model nor a device.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  canonicalModelType,
  testGgufEnvKey,
  ensureGgufForType,
  MODEL_CONFIGS,
  MODEL_TYPE_ALIASES,
  getTestPaths
} = require('./helpers.js')

const ALIAS = 'sortformer-streaming'
const CANONICAL = 'sortformerStreaming'

test('sortformer-streaming alias resolves to the sortformerStreaming config key', (t) => {
  t.is(canonicalModelType(ALIAS), CANONICAL, 'alias maps to canonical config key')
  t.ok(MODEL_TYPE_ALIASES[ALIAS] === CANONICAL, 'alias is declared in MODEL_TYPE_ALIASES')
  t.ok(MODEL_CONFIGS[CANONICAL], 'canonical key exists in MODEL_CONFIGS')
  // Unknown / non-aliased tokens pass through unchanged.
  t.is(canonicalModelType('sortformer'), 'sortformer', 'v1 token is unaffected by aliasing')
})

test('sortformer-streaming derives the canonical QVAC_TEST_GGUF env-key', (t) => {
  t.is(testGgufEnvKey(ALIAS), 'QVAC_TEST_GGUF_SORTFORMERSTREAMING',
    'env-key uses the canonical key, not the hyphenated alias')
  t.is(testGgufEnvKey(ALIAS), testGgufEnvKey(CANONICAL),
    'alias and canonical token derive the same env-key')
})

test('ensureGgufForType(sortformer-streaming) resolves via the canonical env-key override', async (t) => {
  const { modelsDir } = getTestPaths()
  fs.mkdirSync(modelsDir, { recursive: true })
  const sentinel = path.join(modelsDir, 'alias-resolution-sentinel.gguf')
  fs.writeFileSync(sentinel, 'sentinel')

  const envKey = testGgufEnvKey(ALIAS)
  const previous = process.env[envKey]
  process.env[envKey] = sentinel

  t.teardown(() => {
    if (previous === undefined) delete process.env[envKey]
    else process.env[envKey] = previous
    try { fs.unlinkSync(sentinel) } catch (_) {}
  })

  const viaAlias = await ensureGgufForType(ALIAS)
  t.is(viaAlias, sentinel, 'alias token resolves through QVAC_TEST_GGUF_SORTFORMERSTREAMING')

  const viaCanonical = await ensureGgufForType(CANONICAL)
  t.is(viaCanonical, sentinel, 'canonical token resolves to the same file as the alias')
})
