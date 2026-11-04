import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MIN_CLI_VERSION_READY_FD,
  buildQvacLaunch,
  createLocalServiceServeConfig,
  ensureQvacServe,
  formatSpawnError,
  loadApiKey,
  prepareLocalServiceLaunch,
  resolveQvacCli,
  stopQvacServe,
  type LocalServiceOptions
} from '../src/local-service.ts'
import {
  fakeQvacSkip as skip,
  makeFakeQvac,
  setFakeQvacEnv,
  startSquatter
} from './helpers/fake-qvac.ts'

const VALID_KEY = 'abcdefghijklmnopqrstuvwxyzABCDE_'

function serviceOptions(overrides: Partial<LocalServiceOptions> = {}): LocalServiceOptions {
  return {
    qvacCommand: '/usr/local/bin/qvac',
    apiKeyFile: '/tmp/qvac-openclaw/api-key',
    model: 'qwen3.5-9b',
    host: '127.0.0.1',
    port: 0,
    ctxSize: 32768,
    reasoningBudget: -1,
    tools: true,
    readyTimeoutMs: 10_000,
    ...overrides
  }
}

function withKeyFile(fn: (keyFile: string, dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-key-'))
  const keyFile = join(dir, 'api-key')
  writeFileSync(keyFile, VALID_KEY, { mode: 0o600 })
  return Promise.resolve(fn(keyFile, dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true })
  )
}

// `os.tmpdir()` re-reads TMPDIR on every call, so pointing it at an empty
// directory makes the launcher's temp-config bookkeeping directly observable.
// `scratch` stays outside it so test fixtures don't count as launcher leftovers.
async function withIsolatedTmpdir(
  fn: (paths: { tmpRoot: string; scratch: string }) => Promise<void> | void
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

test('serve config and launch args come from the OpenClaw options', async () => {
  await withKeyFile((apiKeyFile) => {
    const options = serviceOptions({
      apiKeyFile,
      port: 11500,
      ctxSize: 65536,
      reasoningBudget: 0,
      tools: false
    })

    assert.deepEqual(createLocalServiceServeConfig(options).serve.models['qwen3.5-9b'], {
      model: 'QWEN3_5_9B_MULTIMODAL_Q4_K_M',
      preload: true,
      default: true,
      config: { ctx_size: 65536, reasoning_budget: 0, tools: false }
    })

    assert.deepEqual(buildQvacLaunch(options, '/tmp/qvac-openclaw/qvac.config.json').args, [
      'serve',
      '--openai',
      '--no-default',
      '--config',
      '/tmp/qvac-openclaw/qvac.config.json',
      '--host',
      '127.0.0.1',
      '--port',
      '11500',
      '--ready-fd',
      '3',
      '--model',
      'qwen3.5-9b',
      '--api-key',
      VALID_KEY
    ])
  })
})

test('serve config resolves the GPT-OSS friendly id to its SDK constant', () => {
  const config = createLocalServiceServeConfig(serviceOptions({ model: 'gpt-oss-20b' }))
  assert.deepEqual(config.serve.models['gpt-oss-20b'], {
    model: 'GPT_OSS_20B_INST_Q4_K_M',
    preload: true,
    default: true,
    config: { ctx_size: 32768, reasoning_budget: -1, tools: true }
  })
})

test('unsafe key-file contents are rejected', () => {
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

test('the key file is re-validated on every read', async () => {
  await withKeyFile((keyFile, dir) => {
    assert.equal(loadApiKey(keyFile), VALID_KEY)

    // Onboarding wrote a private regular file, but the path is long-lived and
    // whatever sits there at launch time is what gets trusted.
    const link = join(dir, 'linked-key')
    symlinkSync(keyFile, link)
    assert.throws(() => loadApiKey(link), /must be a regular file/)

    const loose = join(dir, 'loose-key')
    writeFileSync(loose, VALID_KEY, { mode: 0o644 })
    assert.throws(() => loadApiKey(loose), /readable beyond its owner/)
  })
})

test('launch preparation leaves no temp config directory when the key file is unusable', async () => {
  await withIsolatedTmpdir(({ tmpRoot, scratch }) => {
    const keyFile = join(scratch, 'api-key')
    const options = serviceOptions({ apiKeyFile: keyFile })

    assert.throws(() => prepareLocalServiceLaunch(options))
    assert.deepEqual(readdirSync(tmpRoot), [], 'no temp config dir after a missing key file')

    writeFileSync(keyFile, 'short', { mode: 0o600 })
    assert.throws(() => prepareLocalServiceLaunch(options), /must be 32-128 base64url characters/)
    assert.deepEqual(readdirSync(tmpRoot), [], 'no temp config dir after an invalid key file')
  })
})

test('launch preparation cleans up its temp config directory', async () => {
  await withIsolatedTmpdir(({ tmpRoot, scratch }) => {
    const keyFile = join(scratch, 'api-key')
    writeFileSync(keyFile, VALID_KEY, { mode: 0o600 })
    const options = serviceOptions({ apiKeyFile: keyFile })

    const launch = prepareLocalServiceLaunch(options)
    assert.equal(readdirSync(tmpRoot).length, 1)
    const expected = buildQvacLaunch(options, launch.configPath)
    assert.equal(launch.command, expected.command)
    assert.deepEqual(launch.args, expected.args)

    launch.cleanup()
    assert.deepEqual(readdirSync(tmpRoot), [], 'cleanup removes the temp config dir')
    // Stop and child exit can both run cleanup.
    launch.cleanup()
  })
})

test('spawn errors are formatted without args or secret-bearing properties', () => {
  const error = Object.assign(new Error('spawn qvac ENOENT'), {
    code: 'ENOENT',
    syscall: 'spawn qvac',
    spawnargs: ['serve', '--openai', '--no-default', '--api-key', VALID_KEY]
  })

  const formatted = formatSpawnError(error, '/usr/local/bin/qvac')
  assert.equal(
    formatted,
    'Failed to start QVAC service: code=ENOENT syscall=spawn qvac command=/usr/local/bin/qvac'
  )
  assert.doesNotMatch(formatted, /abcdefghijklmnopqrstuvwxyzABCDE_|spawnargs/)
})

test('a custom command keeps the key on argv, since its version is unknowable', async () => {
  const custom = resolveQvacCli('/opt/custom/qvac')
  assert.equal(custom.supportsApiKeyFile, false)
  assert.equal(custom.command, '/opt/custom/qvac')
  assert.deepEqual(custom.baseArgs, [])

  await withKeyFile((apiKeyFile, dir) => {
    const launch = buildQvacLaunch(
      serviceOptions({ qvacCommand: '/opt/custom/qvac', apiKeyFile }),
      join(dir, 'qvac.config.json')
    )
    assert.equal(launch.command, '/opt/custom/qvac')
    assert.ok(launch.args.includes('--api-key'), 'the fallback still authenticates the serve')
    assert.equal(launch.args.includes('--api-key-file'), false)
  })
})

test('the version gate describes the binary the launcher actually spawns', async () => {
  // The gate reads its version out of the resolved `@qvac/cli`, so that is what
  // has to run: a bare `qvac` off PATH can be an unrelated older global install.
  const resolved = resolveQvacCli('qvac')
  assert.equal(resolved.command, process.execPath)
  assert.equal(resolved.baseArgs.length, 1)
  assert.match(String(resolved.baseArgs[0]), /@qvac[/\\]cli[/\\]/)

  await withKeyFile((apiKeyFile, dir) => {
    const options = serviceOptions({ qvacCommand: 'qvac', apiKeyFile })
    const build = () => buildQvacLaunch(options, join(dir, 'qvac.config.json'))
    const [major = 0, minor = 0] = (resolved.version ?? '0.0.0').split('.').map(Number)
    const [wantMajor = 0, wantMinor = 0] = MIN_CLI_VERSION_READY_FD.split('.').map(Number)
    if (major < wantMajor || (major === wantMajor && minor < wantMinor)) {
      assert.throws(build, /cannot report the port it bound/)
      return
    }
    const launch = build()
    assert.equal(launch.command, resolved.command)
    assert.equal(launch.args[1], 'serve')
    assert.ok(launch.args.includes('--ready-fd'))
    assert.equal(launch.args.includes('--api-key-file'), resolved.supportsApiKeyFile)
  })
})

test('ensureQvacServe returns the port its own serve reported', { skip }, async () => {
  const fake = makeFakeQvac()
  try {
    await withKeyFile(async (apiKeyFile) => {
      const options = serviceOptions({ qvacCommand: fake.command, apiKeyFile })
      const serve = await ensureQvacServe(options)
      assert.match(serve.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      assert.ok(!serve.baseUrl.endsWith(':0/v1'))

      const res = await fetch(`${serve.baseUrl}/models`, {
        headers: { authorization: `Bearer ${VALID_KEY}` }
      })
      assert.equal(res.status, 200)

      assert.equal((await ensureQvacServe(options)).pid, serve.pid, 'reuses the running serve')
      const restarted = await ensureQvacServe({ ...options, model: 'qwen3.5-4b' })
      assert.notEqual(restarted.pid, serve.pid, 'restarts when the launch options change')
    })
  } finally {
    stopQvacServe()
    fake.cleanup()
  }
})

test('a squatter on a pinned port receives nothing and the start fails', { skip }, async () => {
  const fake = makeFakeQvac()
  const squatter = await startSquatter()
  try {
    await withKeyFile(async (apiKeyFile) => {
      await assert.rejects(
        ensureQvacServe(
          serviceOptions({ qvacCommand: fake.command, apiKeyFile, port: squatter.port })
        ),
        /exited before it was ready/
      )
    })
    assert.deepEqual(squatter.requests, [])
  } finally {
    stopQvacServe()
    await squatter.close()
    fake.cleanup()
  }
})

test('a ready line naming another process is not trusted', { skip }, async () => {
  const fake = makeFakeQvac()
  setFakeQvacEnv('BEHAVIOR', 'wrong-pid')
  try {
    await withKeyFile(async (apiKeyFile) => {
      await assert.rejects(
        ensureQvacServe(
          serviceOptions({ qvacCommand: fake.command, apiKeyFile, readyTimeoutMs: 1500 })
        ),
        /did not report its port/
      )
    })
  } finally {
    setFakeQvacEnv('BEHAVIOR', undefined)
    stopQvacServe()
    fake.cleanup()
  }
})

test('a CLI without --ready-fd fails closed with an upgrade hint', { skip }, async () => {
  const fake = makeFakeQvac()
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-argv-'))
  const argvFile = join(dir, 'argv.json')
  setFakeQvacEnv('BEHAVIOR', 'no-ready-fd')
  setFakeQvacEnv('ARGV_FILE', argvFile)
  try {
    await withKeyFile(async (apiKeyFile) => {
      await assert.rejects(
        ensureQvacServe(serviceOptions({ qvacCommand: fake.command, apiKeyFile })),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes(`Install @qvac/cli ${MIN_CLI_VERSION_READY_FD}`)
      )
    })
    assert.ok((JSON.parse(readFileSync(argvFile, 'utf8')) as string[]).includes('--ready-fd'))
  } finally {
    setFakeQvacEnv('BEHAVIOR', undefined)
    setFakeQvacEnv('ARGV_FILE', undefined)
    stopQvacServe()
    fake.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
