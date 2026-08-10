import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildQvacServeArgs,
  createLocalServiceServeConfig,
  parseLocalServiceArgs,
  resolveLocalServiceExitCode
} from '../src/local-service.ts'

test('local service launcher creates QVAC serve config and command args from OpenClaw options', () => {
  const options = parseLocalServiceArgs([
    '--qvac-command',
    '/usr/local/bin/qvac',
    '--api-key',
    'test-openclaw-key',
    '--model',
    'qwen3.5-9b',
    '--host',
    '127.0.0.1',
    '--port',
    '11500',
    '--ctx-size',
    '65536',
    '--reasoning-budget',
    '0',
    '--tools',
    'false'
  ])

  assert.equal(options.qvacCommand, '/usr/local/bin/qvac')
  assert.equal(options.apiKey, 'test-openclaw-key')
  assert.equal(options.model, 'qwen3.5-9b')
  assert.equal(options.port, 11500)

  const config = createLocalServiceServeConfig(options)
  assert.deepEqual(config.serve.models['qwen3.5-9b'], {
    model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
    preload: true,
    default: true,
    config: {
      ctx_size: 65536,
      reasoning_budget: 0,
      tools: false
    }
  })

  assert.deepEqual(buildQvacServeArgs(options, '/tmp/qvac-openclaw/qvac.config.json'), [
    'serve',
    'openai',
    '--config',
    '/tmp/qvac-openclaw/qvac.config.json',
    '--host',
    '127.0.0.1',
    '--port',
    '11500',
    '--model',
    'qwen3.5-9b',
    '--api-key',
    'test-openclaw-key'
  ])
})

test('local service launcher rejects a missing or empty API key', () => {
  assert.throws(() => parseLocalServiceArgs([]), /--api-key requires a non-empty value/)
  assert.throws(
    () => parseLocalServiceArgs(['--api-key', '']),
    /--api-key requires a non-empty value/
  )
})

test('local service launcher resolves GPT-OSS friendly id to SDK constant', () => {
  const options = parseLocalServiceArgs([
    '--api-key',
    'test-openclaw-key',
    '--model',
    'gpt-oss-20b',
    '--ctx-size',
    '32768'
  ])

  const config = createLocalServiceServeConfig(options)
  assert.deepEqual(config.serve.models['gpt-oss-20b'], {
    model: 'GPT_OSS_20B_INST_Q4_K_M',
    preload: true,
    default: true,
    config: {
      ctx_size: 32768,
      reasoning_budget: -1,
      tools: true
    }
  })
})

test('local service exits cleanly for intentional child signal stops', () => {
  assert.equal(resolveLocalServiceExitCode(null, 'SIGTERM', true), 0)
  assert.equal(resolveLocalServiceExitCode(null, 'SIGTERM', false), null)
  assert.equal(resolveLocalServiceExitCode(0, null, false), 0)
  assert.equal(resolveLocalServiceExitCode(null, null, false), 1)
})
