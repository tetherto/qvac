import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildQvacServeArgs,
  createLocalServiceServeConfig,
  formatLauncherError,
  formatSpawnError,
  loadApiKey,
  parseLocalServiceArgs,
  resolveLocalServiceExitCode
} from '../src/local-service.ts'

test('local service launcher creates QVAC serve config and command args from OpenClaw options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-local-service-test-'))
  const keyFile = join(dir, 'api-key')
  writeFileSync(keyFile, 'abcdefghijklmnopqrstuvwxyzABCDE_')
  const options = parseLocalServiceArgs([
    '--qvac-command',
    '/usr/local/bin/qvac',
    '--api-key-file',
    keyFile,
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
  assert.equal(options.apiKeyFile, keyFile)
  assert.equal(loadApiKey(options.apiKeyFile), 'abcdefghijklmnopqrstuvwxyzABCDE_')
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
    'abcdefghijklmnopqrstuvwxyzABCDE_'
  ])
  rmSync(dir, { recursive: true })
})

test('local service launcher rejects a missing or ambiguous API key file', () => {
  assert.throws(() => parseLocalServiceArgs([]), /--api-key-file requires a value/)
  assert.throws(
    () => parseLocalServiceArgs(['--api-key-file', '--model', 'qwen3.5-9b']),
    /--api-key-file requires a value/
  )
  assert.throws(
    () =>
      parseLocalServiceArgs([
        '--api-key-file',
        '/tmp/qvac-openclaw/api-key',
        '--api-key-file',
        '/tmp/qvac-openclaw/other-key'
      ]),
    /--api-key-file cannot be specified more than once/
  )
})

test('local service launcher resolves GPT-OSS friendly id to SDK constant', () => {
  const options = parseLocalServiceArgs([
    '--api-key-file',
    '/tmp/qvac-openclaw/api-key',
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

test('local service launcher rejects unsafe key-file contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-local-service-test-'))
  const keyFile = join(dir, 'api-key')

  for (const value of [
    'short',
    'abcdefghijklmnopqrstuvwxyzABCDE!',
    'abcdefghijklmnopqrstuvwxyzABCD🙂',
    'abcdefghijklmnopqrstuvwxyzABCD\u0000',
    '--modelabcdefghijklmnopqrstuvwxyz'
  ]) {
    writeFileSync(keyFile, value)
    assert.throws(() => loadApiKey(keyFile), /must be 32-128 base64url characters/)
  }

  rmSync(dir, { recursive: true })
})

test('spawn errors are formatted without args or secret-bearing properties', () => {
  const error = Object.assign(new Error('spawn qvac ENOENT'), {
    code: 'ENOENT',
    syscall: 'spawn qvac',
    spawnargs: ['serve', 'openai', '--api-key', 'abcdefghijklmnopqrstuvwxyzABCDE_']
  })

  const formatted = formatSpawnError(error, '/usr/local/bin/qvac')
  assert.equal(
    formatted,
    'Failed to start QVAC service: code=ENOENT syscall=spawn qvac command=/usr/local/bin/qvac'
  )
  assert.doesNotMatch(formatted, /abcdefghijklmnopqrstuvwxyzABCDE_|spawnargs/)
})

test('launcher validation errors retain sanitized diagnostics without raw properties', () => {
  const validationError = Object.assign(
    new TypeError('--api-key-file requires a value\nretry setup'),
    {
      spawnargs: ['--api-key', 'abcdefghijklmnopqrstuvwxyzABCDE_']
    }
  )
  assert.equal(
    formatLauncherError(validationError),
    'QVAC local service launcher failed: --api-key-file requires a value retry setup'
  )

  const configError = Object.assign(new Error('ENOENT: key file not found\ncheck setup'), {
    code: 'ENOENT',
    spawnargs: ['--api-key', 'abcdefghijklmnopqrstuvwxyzABCDE_']
  })
  assert.equal(
    formatLauncherError(configError),
    'QVAC local service launcher failed: ENOENT: key file not found check setup'
  )

  const unknownError = Object.assign(new Error('secret=abcdefghijklmnopqrstuvwxyzABCDE_'), {
    spawnargs: ['--api-key', 'abcdefghijklmnopqrstuvwxyzABCDE_']
  })
  const formatted = formatLauncherError(unknownError)
  assert.equal(formatted, 'QVAC local service launcher failed')
  assert.doesNotMatch(formatted, /abcdefghijklmnopqrstuvwxyzABCDE_|spawnargs/)
})

test('local service exits cleanly for intentional child signal stops', () => {
  assert.equal(resolveLocalServiceExitCode(null, 'SIGTERM', true), 0)
  assert.equal(resolveLocalServiceExitCode(null, 'SIGTERM', false), null)
  assert.equal(resolveLocalServiceExitCode(0, null, false), 0)
  assert.equal(resolveLocalServiceExitCode(null, null, false), 1)
})
