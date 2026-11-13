import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { QvacManagedServe } from '../src/index.ts'
import { mergeOptions, type RawOptions } from '../src/options.ts'
import { spawnManagedServeHost } from '../src/spawn-host.ts'

const PROXY_TOKEN = 'p'.repeat(43)
const PIDFILE_ENV = 'QVAC_TEST_HOST_PIDFILE'

const HANDSHAKE_JSON = JSON.stringify({
  proxyToken: PROXY_TOKEN,
  baseURL: 'http://127.0.0.1:45678/v1',
  modelId: 'qwen3.5-0.8b',
  modelName: 'Qwen 3.5 0.8B'
})

// Stand-ins for the node/bun runtime that hosts managed serve. Each ignores the
// host entry path it is handed and instead exercises one handshake outcome.
const RUNTIMES: Record<string, string> = {
  'fd3-handshake': `fs.writeSync(3, 'QVAC_LISTENING ' + json + '\\n')
process.stdout.write('starting managed serve...\\n')
stayAlive()`,
  'fd3-malformed': `fs.writeSync(3, 'QVAC_LISTENING { not json\\n')
stayAlive()`,
  'stdout-handshake': `process.stdout.write('QVAC_LISTENING ' + json + '\\n')
stayAlive()`,
  silent: `process.stdout.write('booting\\n')
stayAlive()`,
  crash: `process.stderr.write('host boom\\n')
process.exit(3)`
}

interface FakeRuntimes {
  readonly path: (name: keyof typeof RUNTIMES | string) => string
  readonly pidFile: string
  cleanup: () => Promise<void>
}

async function makeFakeRuntimes(): Promise<FakeRuntimes> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-fake-runtime-'))
  const pidFile = join(dir, 'host.pid')
  for (const [name, body] of Object.entries(RUNTIMES)) {
    const script = `#!/usr/bin/env node
const fs = require('node:fs')
const json = ${JSON.stringify(HANDSHAKE_JSON)}
if (process.env['${PIDFILE_ENV}']) fs.writeFileSync(process.env['${PIDFILE_ENV}'], String(process.pid))
function stayAlive () { setInterval(() => {}, 1 << 30) }
${body}
`
    const path = join(dir, `${name}.cjs`)
    await writeFile(path, script, 'utf8')
    await chmod(path, 0o755)
  }
  return {
    path: (name) => join(dir, `${name}.cjs`),
    pidFile,
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isAlive(pid)
}

async function hostPid(runtimes: FakeRuntimes): Promise<number> {
  const raw = await readFile(runtimes.pidFile, 'utf8')
  const pid = Number.parseInt(raw.trim(), 10)
  assert.ok(pid > 0)
  return pid
}

async function withFakeRuntimes(fn: (runtimes: FakeRuntimes) => Promise<void>): Promise<void> {
  const runtimes = await makeFakeRuntimes()
  process.env[PIDFILE_ENV] = runtimes.pidFile
  try {
    await fn(runtimes)
  } finally {
    delete process.env[PIDFILE_ENV]
    await runtimes.cleanup()
  }
}

function options(runtime: string, overrides: RawOptions = {}): ReturnType<typeof mergeOptions> {
  return mergeOptions({ runtime, listenTimeoutMs: 1_500, ...overrides })
}

test('plugin reads the handshake from the dedicated channel, not stdout', async () => {
  await withFakeRuntimes(async (runtimes) => {
    const spawned = await spawnManagedServeHost({
      options: options(runtimes.path('fd3-handshake')),
      projectDir: tmpdir()
    })
    try {
      assert.equal(spawned.listening.proxyToken, PROXY_TOKEN)
      assert.equal(spawned.listening.baseURL, 'http://127.0.0.1:45678/v1')
      assert.equal(spawned.listening.modelId, 'qwen3.5-0.8b')
      assert.ok(isAlive(spawned.child.pid ?? 0))
    } finally {
      spawned.child.kill('SIGKILL')
    }
  })
})

test('a handshake on stdout alone times out and the host is terminated', async () => {
  await withFakeRuntimes(async (runtimes) => {
    await assert.rejects(
      spawnManagedServeHost({
        options: options(runtimes.path('stdout-handshake')),
        projectDir: tmpdir()
      }),
      /did not return a listening handshake/
    )
    assert.equal(await waitForExit(await hostPid(runtimes)), true)
  })
})

test('a silent host times out and is terminated rather than orphaned', async () => {
  await withFakeRuntimes(async (runtimes) => {
    await assert.rejects(
      spawnManagedServeHost({ options: options(runtimes.path('silent')), projectDir: tmpdir() }),
      /did not return a listening handshake/
    )
    assert.equal(await waitForExit(await hostPid(runtimes)), true)
  })
})

test('a malformed handshake is rejected and the host is terminated', async () => {
  await withFakeRuntimes(async (runtimes) => {
    await assert.rejects(
      spawnManagedServeHost({
        options: options(runtimes.path('fd3-malformed')),
        projectDir: tmpdir()
      }),
      /invalid QVAC_LISTENING handshake/
    )
    assert.equal(await waitForExit(await hostPid(runtimes)), true)
  })
})

test('a host that exits before handshaking surfaces its exit code', async () => {
  await withFakeRuntimes(async (runtimes) => {
    await assert.rejects(
      spawnManagedServeHost({ options: options(runtimes.path('crash')), projectDir: tmpdir() }),
      /exited \(code 3\)/
    )
  })
})

type PluginContext = Parameters<typeof QvacManagedServe.setup>[0]

interface FakeContext {
  readonly ctx: PluginContext
  readonly providers: unknown[]
  readonly defaults: [string, string][]
}

function fakeContext(pluginOptions: RawOptions, failProviderTransform = false): FakeContext {
  const providers: unknown[] = []
  const defaults: [string, string][] = []
  const ctx = {
    options: pluginOptions,
    location: { directory: tmpdir() },
    provider: {
      transform: (fn: (editor: { add(input: unknown): void }) => void) => {
        if (failProviderTransform) return Promise.reject(new Error('provider transform rejected'))
        fn({ add: (input) => providers.push(input) })
        return Promise.resolve()
      }
    },
    model: {
      transform: (
        fn: (editor: { default: { set(providerID: string, modelID: string): void } }) => void
      ) => {
        fn({ default: { set: (providerID, modelID) => defaults.push([providerID, modelID]) } })
        return Promise.resolve()
      }
    }
  } as unknown as PluginContext
  return { ctx, providers, defaults }
}

test('plugin is a V2 definition with a stable id', () => {
  assert.equal(QvacManagedServe.id, 'qvac')
  assert.equal(typeof QvacManagedServe.setup, 'function')
})

test('setup registers the qvac provider, sets the default model, and cleanup stops the host', async () => {
  await withFakeRuntimes(async (runtimes) => {
    const fake = fakeContext({ runtime: runtimes.path('fd3-handshake'), listenTimeoutMs: 1_500 })

    const cleanup = await QvacManagedServe.setup(fake.ctx)
    const pid = await hostPid(runtimes)
    try {
      assert.equal(fake.providers.length, 1)
      const provider = fake.providers[0] as {
        info: { id: string; settings: Record<string, unknown> }
        models: { id: string }[]
      }
      assert.equal(provider.info.id, 'qvac')
      assert.equal(provider.info.settings['apiKey'], PROXY_TOKEN)
      assert.equal(provider.info.settings['baseURL'], 'http://127.0.0.1:45678/v1')
      assert.deepEqual(
        provider.models.map((m) => m.id),
        ['qwen3.5-0.8b']
      )
      assert.deepEqual(fake.defaults, [['qvac', 'qwen3.5-0.8b']])
      assert.ok(isAlive(pid))
    } finally {
      assert.equal(typeof cleanup, 'function')
      if (typeof cleanup === 'function') await cleanup()
    }
    assert.equal(await waitForExit(pid), true)
  })
})

test('setDefaultModel: false leaves the default model untouched', async () => {
  await withFakeRuntimes(async (runtimes) => {
    const fake = fakeContext({
      runtime: runtimes.path('fd3-handshake'),
      listenTimeoutMs: 1_500,
      setDefaultModel: false
    })

    const cleanup = await QvacManagedServe.setup(fake.ctx)
    if (typeof cleanup === 'function') await cleanup()

    assert.equal(fake.providers.length, 1)
    assert.deepEqual(fake.defaults, [])
  })
})

test('a failed provider registration terminates the host', async () => {
  await withFakeRuntimes(async (runtimes) => {
    const fake = fakeContext(
      { runtime: runtimes.path('fd3-handshake'), listenTimeoutMs: 1_500 },
      true
    )

    await assert.rejects(
      () => Promise.resolve(QvacManagedServe.setup(fake.ctx)),
      /provider transform rejected/
    )
    assert.equal(await waitForExit(await hostPid(runtimes)), true)
  })
})

test('a malformed handshake registers no provider and terminates the host', async () => {
  await withFakeRuntimes(async (runtimes) => {
    const fake = fakeContext({ runtime: runtimes.path('fd3-malformed'), listenTimeoutMs: 1_500 })

    await assert.rejects(
      () => Promise.resolve(QvacManagedServe.setup(fake.ctx)),
      /invalid QVAC_LISTENING handshake/
    )
    assert.equal(fake.providers.length, 0)
    assert.equal(await waitForExit(await hostPid(runtimes)), true)
  })
})
