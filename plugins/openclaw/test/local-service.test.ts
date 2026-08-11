import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildQvacLaunch,
  createLocalServiceServeConfig,
  formatLauncherError,
  formatSpawnError,
  loadApiKey,
  parseLocalServiceArgs,
  prepareLocalServiceLaunch,
  resolveLocalServiceExitCode,
  resolveQvacCli
} from '../src/local-service.ts'

const VALID_KEY = 'abcdefghijklmnopqrstuvwxyzABCDE_'

// `os.tmpdir()` re-reads TMPDIR on every call, so pointing it at an empty
// directory makes the launcher's temp-config bookkeeping directly observable.
// `scratch` stays outside it so test fixtures don't count as launcher leftovers.
async function withIsolatedTmpdir(
  fn: (paths: { tmpRoot: string; scratch: string }) => Promise<void>
): Promise<void> {
  const previous = process.env['TMPDIR']
  const tmpRoot = mkdtempSync(join(tmpdir(), 'qvac-openclaw-tmproot-'))
  const scratch = mkdtempSync(join(tmpdir(), 'qvac-openclaw-scratch-'))
  process.env['TMPDIR'] = tmpRoot
  try {
    await fn({ tmpRoot, scratch })
  } finally {
    if (previous === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = previous
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('local service launcher creates QVAC serve config and command args from OpenClaw options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-local-service-test-'))
  const keyFile = join(dir, 'api-key')
  writeFileSync(keyFile, 'abcdefghijklmnopqrstuvwxyzABCDE_', { mode: 0o600 })
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

  assert.deepEqual(buildQvacLaunch(options, '/tmp/qvac-openclaw/qvac.config.json').args, [
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

test('local service launcher tells pre-upgrade installs to re-onboard', () => {
  // An OpenClaw install onboarded before bearer auth has a persisted arg list
  // with no `--api-key-file`. Failing closed is correct, but the message has to
  // name the remedy or the whole existing user base is stuck on a raw arg error.
  assert.throws(
    () => parseLocalServiceArgs([]),
    (error: unknown) => {
      assert.ok(error instanceof TypeError)
      assert.match(error.message, /--api-key-file/)
      assert.match(error.message, /openclaw onboard --auth-choice qvac/)
      return true
    }
  )
  assert.match(
    formatLauncherError(new TypeError(parseFailureMessage())),
    /openclaw onboard --auth-choice qvac/
  )
})

function parseFailureMessage(): string {
  try {
    parseLocalServiceArgs([])
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : ''
  }
}

test('local service launcher rejects a missing or ambiguous API key file', () => {
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

  const secretLookingOption = '--secret-looking-token-abcdefghijklmnopqrstuvwxyzABCDE_'
  assert.throws(
    () => parseLocalServiceArgs([secretLookingOption, 'value']),
    (error: unknown) => {
      assert.ok(error instanceof TypeError)
      assert.match(error.message, /^Unknown local service option\. Expected one of: --qvac-command/)
      assert.doesNotMatch(error.message, /abcdefghijklmnopqrstuvwxyzABCDE_/)
      return true
    }
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
    writeFileSync(keyFile, value, { mode: 0o600 })
    assert.throws(() => loadApiKey(keyFile), /must be 32-128 base64url characters/)
  }

  rmSync(dir, { recursive: true })
})

test('launch preparation leaves no temp config directory when the key file is unusable', async () => {
  await withIsolatedTmpdir(async ({ tmpRoot, scratch }) => {
    const keyFile = join(scratch, 'api-key')
    const options = parseLocalServiceArgs(['--api-key-file', keyFile])

    // Missing key file.
    await assert.rejects(prepareLocalServiceLaunch(options))
    assert.deepEqual(readdirSync(tmpRoot), [], 'no temp config dir after a missing key file')

    // Present but unusable key file.
    writeFileSync(keyFile, 'short', { mode: 0o600 })
    await assert.rejects(prepareLocalServiceLaunch(options), /must be 32-128 base64url characters/)
    assert.deepEqual(readdirSync(tmpRoot), [], 'no temp config dir after an invalid key file')
  })
})

test('launch preparation cleans up its temp config directory on shutdown', async () => {
  await withIsolatedTmpdir(async ({ tmpRoot, scratch }) => {
    const keyFile = join(scratch, 'api-key')
    writeFileSync(keyFile, VALID_KEY, { mode: 0o600 })
    const options = parseLocalServiceArgs(['--api-key-file', keyFile])

    const launch = await prepareLocalServiceLaunch(options)
    assert.equal(readdirSync(tmpRoot).length, 1)
    const expected = buildQvacLaunch(options, launch.configPath)
    assert.equal(launch.command, expected.command)
    assert.deepEqual(launch.args, expected.args)

    await launch.cleanup()
    assert.deepEqual(readdirSync(tmpRoot), [], 'cleanup removes the temp config dir')
    // Shutdown paths can run cleanup more than once (stop + child exit).
    await launch.cleanup()
  })
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

test('local service launcher re-validates the key file on every read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-key-'))
  try {
    const keyFile = join(dir, 'api-key')
    writeFileSync(keyFile, VALID_KEY, { mode: 0o600 })
    assert.equal(loadApiKey(keyFile), VALID_KEY)

    // Onboarding wrote a private regular file, but the path is long-lived and
    // whatever sits there at launch time is what gets trusted.
    const link = join(dir, 'linked-key')
    symlinkSync(keyFile, link)
    assert.throws(() => loadApiKey(link), /must be a regular file/)

    const loose = join(dir, 'loose-key')
    writeFileSync(loose, VALID_KEY, { mode: 0o644 })
    assert.throws(() => loadApiKey(loose), /readable beyond its owner/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local service launcher keeps the key out of argv only against a CLI that supports it', () => {
  // A custom command points somewhere unversionable, so it must not be handed a
  // flag that would make an older CLI refuse to start at all.
  const custom = resolveQvacCli('/opt/custom/qvac')
  assert.equal(custom.supportsApiKeyFile, false)
  assert.equal(custom.command, '/opt/custom/qvac')
  assert.deepEqual(custom.baseArgs, [])

  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-key-'))
  try {
    const apiKeyFile = join(dir, 'api-key')
    writeFileSync(apiKeyFile, VALID_KEY, { mode: 0o600 })
    const launch = buildQvacLaunch(
      {
        qvacCommand: '/opt/custom/qvac',
        apiKeyFile,
        model: 'qwen3.5-9b',
        host: '127.0.0.1',
        port: 11434,
        ctxSize: 32768,
        reasoningBudget: 0,
        tools: true
      },
      join(dir, 'qvac.config.json')
    )
    assert.equal(launch.command, '/opt/custom/qvac')
    assert.ok(launch.args.includes('--api-key'), 'the fallback still authenticates the serve')
    assert.equal(launch.args.includes('--api-key-file'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the version gate describes the binary the launcher actually spawns', () => {
  // The gate reads its version out of the resolved `@qvac/cli`, so that is what
  // has to run: a bare `qvac` off PATH can be an unrelated older global install
  // that would die on the `--api-key-file` this decided to pass.
  const resolved = resolveQvacCli('qvac')
  assert.equal(resolved.command, process.execPath)
  assert.equal(resolved.baseArgs.length, 1)
  assert.match(String(resolved.baseArgs[0]), /@qvac[/\\]cli[/\\]/)

  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-key-'))
  try {
    const apiKeyFile = join(dir, 'api-key')
    writeFileSync(apiKeyFile, VALID_KEY, { mode: 0o600 })
    const launch = buildQvacLaunch(
      {
        qvacCommand: 'qvac',
        apiKeyFile,
        model: 'qwen3.5-9b',
        host: '127.0.0.1',
        port: 11434,
        ctxSize: 32768,
        reasoningBudget: 0,
        tools: true
      },
      join(dir, 'qvac.config.json')
    )
    assert.equal(launch.command, resolved.command)
    assert.equal(launch.args[0], resolved.baseArgs[0])
    assert.equal(launch.args[1], 'serve')
    assert.equal(
      launch.args.includes('--api-key-file'),
      resolved.supportsApiKeyFile,
      'the credential form follows the version of the entry being spawned'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
