import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import * as Harness from '../index.ts'

const EXECUTABLE = '/usr/local/bin/obsidian'
const VAULT = '/private/tmp/synthetic-vault'
const VAULT_IDENTITY = 'SyntheticVault'
const CLI_SOCKET = '/Users/synthetic/.obsidian-cli.sock'

test.each([
  'obsidian read path=note.md; id',
  'obsidian read path=note.md && id',
  'obsidian read path=note.md | cat',
  'obsidian read path=note.md > /tmp/out',
  'obsidian read path=$(id)',
  'obsidian read path=`id`',
  'HOME=/tmp obsidian version',
  'obsidian version\nobsidian vaults'
])('Obsidian rejects shell syntax before argv construction: %s', (command) => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  expect(parse(command, EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.any(String)
  })
})

test('Obsidian accepts only the exact configured executable path or name', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  expect(
    parse(
      'obsidian read path="Projects/Meeting notes.md"',
      EXECUTABLE,
      VAULT_IDENTITY
    )
  ).toEqual({
    ok: true,
    argv: [
      `vault=${VAULT_IDENTITY}`,
      'read',
      'path=Projects/Meeting notes.md'
    ]
  })
  expect(parse(`"${EXECUTABLE}" files`, EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
  expect(parse('/Applications/Obsidian.app/Contents/MacOS/Obsidian files', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/configured.*executable/i)
  })
  expect(parse('./obsidian files', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/configured.*executable/i)
  })
})

test('Obsidian accepts the registered PATH name when the binary is obsidian-cli', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  const officialCli =
    '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli'
  expect(parse('obsidian files', officialCli, VAULT_IDENTITY)).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
  expect(parse('obsidian-cli files', officialCli, VAULT_IDENTITY)).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
  expect(
    parse(`"${officialCli}" files`, officialCli, VAULT_IDENTITY)
  ).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
})

test('Obsidian validates operations, options, and vault-relative paths', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  expect(parse('obsidian delete path=note.md', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.any(String)
  })
  expect(parse('obsidian read --unknown value', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.any(String)
  })
  expect(parse('obsidian read path=/tmp/secret.md', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/absolute|vault-relative/i)
  })
  expect(parse('obsidian read path=../../secret.md', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/traversal/i)
  })
  expect(parse('obsidian read file=../../secret.md', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/traversal/i)
  })
  expect(parse('obsidian create name=../../secret', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/traversal/i)
  })
})

test('Obsidian rejects vault discovery and model-supplied vault selectors', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  expect(parse('obsidian vaults', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/operation|command|unexpected/i)
  })
  expect(parse('obsidian vault list', EXECUTABLE, VAULT_IDENTITY)).toEqual({
    ok: false,
    error: expect.stringMatching(/operation|command|unexpected|vault selector/i)
  })
  expect(
    parse(
      'obsidian read path=allowed.md vault=OtherVault',
      EXECUTABLE,
      VAULT_IDENTITY
    )
  ).toEqual({
    ok: false,
    error: expect.stringMatching(/vault selector/i)
  })
  expect(
    parse(
      'obsidian read path=allowed.md --vault OtherVault',
      EXECUTABLE,
      VAULT_IDENTITY
    )
  ).toEqual({
    ok: false,
    error: expect.stringMatching(/vault selector/i)
  })
})

test('Obsidian accepts a matching leading vault selector then reinjects it once', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  const officialCli =
    '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli'
  const operations = ['files', 'search', 'read', 'daily:read', 'version']
  expect(
    parse(
      `obsidian vault=${VAULT_IDENTITY} files`,
      officialCli,
      VAULT_IDENTITY,
      operations
    )
  ).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
  expect(
    parse(
      `/usr/local/bin/obsidian vault=${VAULT_IDENTITY} files`,
      officialCli,
      VAULT_IDENTITY,
      operations
    )
  ).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'files']
  })
  expect(
    parse(
      'obsidian vault=OtherVault files',
      officialCli,
      VAULT_IDENTITY,
      operations
    )
  ).toEqual({
    ok: false,
    error: expect.stringMatching(/vault selector/i)
  })
})

test('Obsidian injects exactly one trusted configured vault selector', () => {
  const parse = Reflect.get(Harness, 'parseObsidianCommand')
  expect(typeof parse).toBe('function')
  if (typeof parse !== 'function') return

  expect(
    parse(
      'obsidian read path="Projects/Meeting notes.md"',
      EXECUTABLE,
      VAULT_IDENTITY
    )
  ).toEqual({
    ok: true,
    argv: [
      `vault=${VAULT_IDENTITY}`,
      'read',
      'path=Projects/Meeting notes.md'
    ]
  })
  expect(
    parse('obsidian version', EXECUTABLE, VAULT_IDENTITY)
  ).toEqual({
    ok: true,
    argv: [`vault=${VAULT_IDENTITY}`, 'version']
  })
})

test('Obsidian vault discovery and alternate selectors never launch', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  let launches = 0
  const executor = createExecutor(desktopConfiguration(), {
    spawn() {
      launches++
      return fakeChild({ exitCode: 0 })
    }
  })

  expect(
    await executor.invoke(
      executionRequest('exec', { command: 'obsidian vaults' })
    )
  ).toEqual({ error: expect.any(String) })
  expect(
    await executor.invoke(
      executionRequest('exec', {
        command: 'obsidian read path=allowed.md vault=OtherVault'
      })
    )
  ).toEqual({ error: expect.stringMatching(/vault selector/i) })
  expect(launches).toBe(0)
})

test('runner read-only Obsidian policy rejects mutations before launch', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  let launches = 0
  const executor = createExecutor(
    desktopConfiguration({
      allowedOperations: ['files', 'search', 'read', 'daily:read', 'version']
    }),
    {
      spawn() {
        launches++
        return fakeChild({ exitCode: 0 })
      }
    }
  )

  expect(
    await executor.invoke(
      executionRequest('exec', {
        command: 'obsidian create path=blocked.md content=blocked'
      })
    )
  ).toEqual({ error: expect.stringMatching(/read-only/i) })
  expect(
    await executor.invoke(
      executionRequest('exec', {
        command: 'obsidian append path=allowed.md content=blocked'
      })
    )
  ).toEqual({ error: expect.stringMatching(/read-only/i) })
  expect(launches).toBe(0)

  await executor.invoke(
    executionRequest('exec', { command: 'obsidian read path=allowed.md' })
  )
  expect(launches).toBe(1)
})

test('Obsidian spawns explicit direct argv with a vault cwd and minimal environment', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  let invocation: SpawnInvocation | undefined
  const executor = createExecutor(
    desktopConfiguration(),
    {
      spawn(file: string, argv: readonly string[], options: SpawnOptions) {
        invocation = { file, argv: [...argv], options }
        return fakeChild({ stdout: 'note body\n', exitCode: 0 })
      }
    }
  )
  const result = await executor.invoke(
    executionRequest('exec', {
      command: 'obsidian read path="Projects/Meeting notes.md"'
    })
  )

  expect(invocation).toEqual({
    file: EXECUTABLE,
    argv: [
      `vault=${VAULT_IDENTITY}`,
      'read',
      'path=Projects/Meeting notes.md'
    ],
    options: {
      cwd: VAULT,
      env: {
        HOME: '/Users/synthetic',
        LANG: 'C',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/private/tmp/scratch'
      },
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  })
  expect(result).toEqual({ exitCode: 0, stdout: 'note body\n', stderr: '' })
})

test('Obsidian caps output bytes and terminates timed-out or cancelled children', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const capped = createExecutor(
    desktopConfiguration({ maxOutputBytes: 32 }),
    {
      spawn() {
        return fakeChild({
          stdout: ['12345678901234567890123456789012', 'overflow'],
          stderr: 'abcdefghijklmnopqrstuvwxyz0123456789',
          exitCode: 0
        })
      }
    }
  )
  expect(
    await capped.invoke(executionRequest('exec', { command: 'obsidian files' }))
  ).toEqual({
    exitCode: 0,
    stdout: '12345678901234567… [truncated]',
    stderr: 'abcdefghijklmnopq… [truncated]'
  })

  const timeoutChild = fakeChild({ hang: true })
  const timed = createExecutor(
    desktopConfiguration({ timeoutMs: 10 }),
    { spawn: () => timeoutChild }
  )
  expect(
    await timed.invoke(executionRequest('exec', { command: 'obsidian files' }))
  ).toEqual({ error: expect.stringMatching(/timed out/i) })
  expect(timeoutChild.killed).toBe(true)

  const cancelChild = fakeChild({ hang: true })
  const cancelled = createExecutor(
    desktopConfiguration(),
    { spawn: () => cancelChild }
  )
  const controller = new AbortController()
  const pending = cancelled.invoke(
    executionRequest('exec', { command: 'obsidian files' }, controller.signal)
  )
  controller.abort()
  expect(await pending).toEqual({ error: expect.stringMatching(/cancelled/i) })
  expect(cancelChild.killed).toBe(true)
})

test('Obsidian escalates termination when a timed-out child ignores SIGTERM', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const child = fakeChild({ hang: true, ignoreTerminate: true })
  const executor = createExecutor(
    desktopConfiguration({ timeoutMs: 10 }),
    { spawn: () => child }
  )

  expect(
    await executor.invoke(
      executionRequest('exec', { command: 'obsidian files' })
    )
  ).toEqual({ error: expect.stringMatching(/timed out/i) })
  await Bun.sleep(300)
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
})

test('Obsidian cancellation waits for confirmed child exit', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const child = fakeChild({ hang: true, terminationDelayMs: 50 })
  const executor = createExecutor(desktopConfiguration(), {
    spawn: () => child
  })
  const controller = new AbortController()
  const pending = executor.invoke(
    executionRequest('exec', { command: 'obsidian search query=hang' }, controller.signal)
  )
  controller.abort()

  expect(
    await Promise.race([
      pending.then(() => 'resolved'),
      Bun.sleep(10).then(() => 'pending')
    ])
  ).toBe('pending')
  expect(await pending).toEqual({
    error: expect.stringMatching(/cancelled/i)
  })
  expect(child.exited).toBe(true)
})

test('Obsidian timeout resolves after bounded SIGKILL escalation without exit', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const child = fakeChild({
    hang: true,
    ignoreTerminate: true,
    ignoreKill: true
  })
  const executor = createExecutor(
    desktopConfiguration({ timeoutMs: 10 }),
    { spawn: () => child }
  )
  const started = Date.now()
  const result = await executor.invoke(
    executionRequest('exec', { command: 'obsidian search query=hang' })
  )
  const elapsed = Date.now() - started

  expect(result).toEqual({ error: expect.stringMatching(/timed out/i) })
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(child.exited).toBe(false)
  expect(elapsed).toBeGreaterThanOrEqual(500)
  expect(elapsed).toBeLessThan(1_500)
})

test('desktop executor close terminates and awaits every active subprocess', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const child = fakeChild({ hang: true, ignoreTerminate: true })
  const executor = createExecutor(desktopConfiguration(), {
    spawn: () => child
  })
  const pending = executor.invoke(
    executionRequest('exec', { command: 'obsidian search query=hang' })
  )
  await Bun.sleep(5)

  expect(typeof executor.close).toBe('function')
  if (typeof executor.close !== 'function') return
  await executor.close()

  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(child.exited).toBe(true)
  expect(await pending).toEqual({
    error: expect.stringMatching(/closed/i)
  })
})

test('Weather child captures max-sized escape-heavy proxy JSON without truncation', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const body = '\0'.repeat(8_192)
  const executor = createExecutor(
    {
      enabledTools: ['http_request'],
      scratchRoot: '/private/tmp/scratch',
      weather: {
        agentId: 'weather-agent',
        port: 43123,
        token: 'fixture-token',
        maxResponseBytes: 8_192
      }
    },
    {
      request: fakeLoopbackRequest(
        `${JSON.stringify({ status: 200, body })}\n`
      )
    }
  )

  expect(
    await executor.invoke(
      executionRequest('http_request', {
        url: 'https://wttr.in/Probe?format=3',
        method: 'GET'
      })
    )
  ).toEqual({ status: 200, body })
})

test('Obsidian truncation suffix stays inside byte cap for multibyte output', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const executor = createExecutor(
    desktopConfiguration({ maxOutputBytes: 32 }),
    {
      spawn() {
        return fakeChild({
          stdout: '😀'.repeat(16),
          stderr: '\\"'.repeat(32),
          exitCode: 0
        })
      }
    }
  )
  const result = await executor.invoke(
    executionRequest('exec', { command: 'obsidian read path=allowed.md' })
  )
  expect(typeof result).toBe('object')
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return
  const stdout = Reflect.get(result, 'stdout')
  const stderr = Reflect.get(result, 'stderr')
  expect(typeof stdout).toBe('string')
  expect(typeof stderr).toBe('string')
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return

  expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(32)
  expect(Buffer.byteLength(stderr, 'utf8')).toBeLessThanOrEqual(32)
  expect(stdout).toEndWith('… [truncated]')
  expect(stderr).toEndWith('… [truncated]')
})

test('Obsidian caps decoded invalid UTF-8 for stdout and stderr', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const maxOutputBytes = 32
  const executor = createExecutor(
    desktopConfiguration({ maxOutputBytes }),
    {
      spawn() {
        return fakeChild({
          stdout: Buffer.alloc(maxOutputBytes, 0xff),
          stderr: Buffer.alloc(maxOutputBytes, 0xfe),
          exitCode: 0
        })
      }
    }
  )
  const result = await executor.invoke(
    executionRequest('exec', { command: 'obsidian read path=allowed.md' })
  )
  expect(typeof result).toBe('object')
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return
  const stdout = Reflect.get(result, 'stdout')
  const stderr = Reflect.get(result, 'stderr')
  expect(typeof stdout).toBe('string')
  expect(typeof stderr).toBe('string')
  if (typeof stdout !== 'string' || typeof stderr !== 'string') return

  expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(maxOutputBytes)
  expect(Buffer.byteLength(stderr, 'utf8')).toBeLessThanOrEqual(maxOutputBytes)
  expect(stdout).toEndWith('… [truncated]')
  expect(stderr).toEndWith('… [truncated]')
})

test('desktop executor rejects unknown, image, and unselected tools', async () => {
  const createExecutor = Reflect.get(Harness, 'createDesktopToolExecutor')
  expect(typeof createExecutor).toBe('function')
  if (typeof createExecutor !== 'function') return

  const executor = createExecutor(desktopConfiguration({ enabledTools: ['exec'] }), {
    spawn() {
      throw new Error('must not spawn')
    }
  })

  await expect(
    executor.invoke(executionRequest('generate_image', { prompt: 'sky' }))
  ).rejects.toThrow(/not registered/i)
  await expect(
    executor.invoke(
      executionRequest('http_request', {
        url: 'https://wttr.in/London?format=3',
        method: 'GET'
      })
    )
  ).rejects.toThrow(/not registered/i)
})

function desktopConfiguration(
  overrides: {
    enabledTools?: readonly ('http_request' | 'exec')[]
    timeoutMs?: number
    maxOutputBytes?: number
    allowedOperations?: readonly string[]
  } = {}
) {
  return {
    enabledTools: overrides.enabledTools ?? ['exec'],
    scratchRoot: '/private/tmp/scratch',
    obsidian: {
      executablePath: EXECUTABLE,
      vaultRoot: VAULT,
      vaultIdentity: VAULT_IDENTITY,
      cliSocketPath: CLI_SOCKET,
      timeoutMs: overrides.timeoutMs ?? 5_000,
      maxOutputBytes: overrides.maxOutputBytes ?? 8_192,
      ...(overrides.allowedOperations
        ? { allowedOperations: overrides.allowedOperations }
        : {})
    }
  }
}

function executionRequest(
  toolName: string,
  input: Record<string, string>,
  signal: AbortSignal = new AbortController().signal
) {
  return {
    invocationId: 'test-invocation',
    generation: 1,
    toolName,
    input,
    signal
  }
}

interface SpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly shell: false
  readonly detached: false
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
}

interface SpawnInvocation {
  readonly file: string
  readonly argv: readonly string[]
  readonly options: SpawnOptions
}

type OutputChunk = string | Uint8Array

function fakeChild(options: {
  stdout?: OutputChunk | readonly OutputChunk[]
  stderr?: OutputChunk | readonly OutputChunk[]
  exitCode?: number
  hang?: boolean
  ignoreTerminate?: boolean
  ignoreKill?: boolean
  terminationDelayMs?: number
}) {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let killed = false
  let exited = false
  const signals: string[] = []
  const child = {
    stdout,
    stderr,
    get killed() {
      return killed
    },
    get exited() {
      return exited
    },
    signals,
    kill(signal = 'SIGTERM') {
      killed = true
      signals.push(String(signal))
      if (options.ignoreTerminate && signal === 'SIGTERM') return
      if (options.ignoreKill && signal === 'SIGKILL') return
      const emitExit = () => {
        exited = true
        events.emit('exit', null, String(signal))
      }
      if (options.terminationDelayMs) {
        setTimeout(emitExit, options.terminationDelayMs)
      } else {
        queueMicrotask(emitExit)
      }
    },
    once(event: string, listener: (...args: readonly (number | string | null | Error)[]) => void) {
      events.once(event, listener)
      return child
    }
  }
  queueMicrotask(() => {
    if (options.hang || killed) return
    for (const chunk of asArray(options.stdout)) stdout.write(chunk)
    for (const chunk of asArray(options.stderr)) stderr.write(chunk)
    stdout.end()
    stderr.end()
    exited = true
    events.emit('exit', options.exitCode ?? 0, null)
  })
  return child
}

function asArray(
  value: OutputChunk | readonly OutputChunk[] | undefined
): readonly OutputChunk[] {
  if (value === undefined) return []
  if (typeof value === 'string' || value instanceof Uint8Array) return [value]
  return value
}

function fakeLoopbackRequest(body: string) {
  return (
    _options: object,
    onResponse: (response: {
      statusCode: number
      on(event: 'data', listener: (chunk: string) => void): object
      once(event: 'end' | 'error', listener: (...args: readonly Error[]) => void): object
      destroy(): void
    }) => void
  ) => {
    const responseEvents = new EventEmitter()
    const response = {
      statusCode: 200,
      on(event: 'data', listener: (chunk: string) => void) {
        responseEvents.on(event, listener)
        return response
      },
      once(
        event: 'end' | 'error',
        listener: (...args: readonly Error[]) => void
      ) {
        responseEvents.once(event, listener)
        return response
      },
      destroy() {}
    }
    const requestEvents = new EventEmitter()
    return {
      once(event: 'error', listener: (error: Error) => void) {
        requestEvents.once(event, listener)
        return this
      },
      end() {
        queueMicrotask(() => {
          onResponse(response)
          responseEvents.emit('data', body)
          responseEvents.emit('end')
        })
      },
      destroy(error?: Error) {
        if (error) requestEvents.emit('error', error)
      }
    }
  }
}
