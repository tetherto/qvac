import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { InvalidOptionError } from '../src/errors.ts'
import { resolveManagedServeHostConfig } from '../src/managed-serve-config.ts'
import {
  DEFAULT_OPTIONS,
  hostEnv,
  mergeOptions,
  optionsFromEnv,
  resolveOptions
} from '../src/options.ts'

test('mergeOptions returns the defaults when given nothing', () => {
  assert.deepEqual(mergeOptions(), DEFAULT_OPTIONS)
})

test('mergeOptions applies later sources over earlier ones', () => {
  const out = mergeOptions({ model: 'qwen3.5-2b', ctxSize: 8192 }, { ctxSize: 16384 })
  assert.equal(out.model, 'qwen3.5-2b')
  assert.equal(out.ctxSize, 16384)
})

test('mergeOptions coerces string numbers and booleans (from env-style values)', () => {
  const out = mergeOptions({ ctxSize: '4096', reasoningBudget: '0', tools: 'false', shim: '0' })
  assert.equal(out.ctxSize, 4096)
  assert.equal(out.reasoningBudget, 0)
  assert.equal(out.tools, false)
  assert.equal(out.shim, false)
})

test('mergeOptions rejects a non-numeric number option', () => {
  assert.throws(() => mergeOptions({ ctxSize: 'lots' }), InvalidOptionError)
})

test('mergeOptions rejects a non-boolean boolean option', () => {
  assert.throws(() => mergeOptions({ tools: 'maybe' }), InvalidOptionError)
})

test('optionsFromEnv maps only the set QVAC_* vars', () => {
  const raw = optionsFromEnv({ QVAC_MODEL: 'qwen3.5-4b', QVAC_DEBUG: '1' })
  assert.deepEqual(raw, { model: 'qwen3.5-4b', debug: '1' })
})

test('resolveOptions precedence: env over plugin options over qvac.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-opt-'))
  try {
    writeFileSync(join(dir, 'qvac.json'), JSON.stringify({ model: 'qwen3.5-0.8b', ctxSize: 2048 }))
    const out = resolveOptions({
      projectDir: dir,
      pluginOptions: { model: 'qwen3.5-2b' },
      env: { QVAC_MODEL: 'qwen3.5-9b' }
    })
    assert.equal(out.model, 'qwen3.5-9b') // env wins
    assert.equal(out.ctxSize, 2048) // from qvac.json, untouched by higher sources
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveOptions tolerates a missing qvac.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-opt-'))
  try {
    const out = resolveOptions({ projectDir: dir, env: {} })
    assert.equal(out.model, DEFAULT_OPTIONS.model)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveOptions rejects a malformed qvac.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-opt-'))
  try {
    writeFileSync(join(dir, 'qvac.json'), '{ not json')
    assert.throws(() => resolveOptions({ projectDir: dir, env: {} }), InvalidOptionError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostEnv carries the resolved model-loading subset as strings', () => {
  const env = hostEnv(
    mergeOptions({ model: 'qwen3.5-9b', ctxSize: 32768, tools: true, shim: false })
  )
  assert.equal(env['QVAC_MODEL'], 'qwen3.5-9b')
  assert.equal(env['QVAC_CTX_SIZE'], '32768')
  assert.equal(env['QVAC_TOOLS'], 'true')
  assert.equal(env['QVAC_SHIM'], 'false')
})

test('resolveManagedServeHostConfig is derived from the host env', () => {
  const config = resolveManagedServeHostConfig({
    QVAC_MODEL: 'qwen3.5-4b',
    QVAC_CTX_SIZE: '8192',
    QVAC_REASONING_BUDGET: '0',
    QVAC_TOOLS: 'false',
    QVAC_SHIM: 'false',
    QVAC_DEBUG: '1',
    QVAC_READY_TIMEOUT_MS: '1234',
    QVAC_UPSTREAM_TIMEOUT_MS: '5678',
    QVAC_HOST_LOG: '/tmp/qvac-host.log'
  })
  assert.equal(config.modelId, 'qwen3.5-4b')
  assert.equal(config.ctxSize, 8192)
  assert.equal(config.reasoningBudget, 0)
  assert.equal(config.tools, false)
  assert.equal(config.openAICompatTransforms, false)
  assert.equal(config.debug, true)
  assert.equal(config.readyTimeoutMs, 1234)
  assert.equal(config.upstreamTimeoutMs, 5678)
  assert.equal(config.logFile, '/tmp/qvac-host.log')
})
