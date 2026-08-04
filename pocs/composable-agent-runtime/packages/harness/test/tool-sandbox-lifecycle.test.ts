import { expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as HarnessProduction from '../index.ts'
import * as HarnessTesting from '../testing.ts'
import type {
  HarnessJsonValue,
  ToolSandboxResult
} from '../index.ts'

const Harness = { ...HarnessProduction, ...HarnessTesting }

test('fake sandbox launcher is available only from the testing entrypoint', () => {
  expect(Reflect.get(HarnessProduction, 'createFakeToolSandboxLauncher')).toBeUndefined()
  expect(typeof HarnessTesting.createFakeToolSandboxLauncher).toBe('function')
})

test('sandbox launcher uses exact direct argv without a shell', () => {
  const buildInvocation = Reflect.get(Harness, 'buildMacOsSandboxExecInvocation')
  expect(typeof buildInvocation).toBe('function')
  if (typeof buildInvocation !== 'function') return

  expect(
    buildInvocation({
      profilePath: '/private/tmp/sandbox/seatbelt.sb',
      scratchRoot: '/private/tmp/sandbox/scratch',
      bareExecutable: '/private/app/bare',
      childEntry: '/private/app/tool-child.bundle',
      generation: 7
    })
  ).toEqual({
    file: '/usr/bin/sandbox-exec',
    args: [
      '-f',
      '/private/tmp/sandbox/seatbelt.sb',
      '/private/app/bare',
      '/private/app/tool-child.bundle',
      '--sandbox-generation=7'
    ],
    options: {
      cwd: '/',
      env: {
        HOME: '/private/tmp/sandbox/scratch',
        LANG: 'C',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/private/tmp/sandbox/scratch'
      },
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe']
    }
  })
})

test('registry starts lazily and keeps one sandbox per agent', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  expect(launcher.launches).toHaveLength(0)

  await registry.invoke({
    agentId: 'agent-a',
    invocationId: 'first',
    toolName: 'exec',
    input: { command: 'one' }
  })
  await registry.invoke({
    agentId: 'agent-a',
    invocationId: 'second',
    toolName: 'exec',
    input: { command: 'two' }
  })
  await registry.invoke({
    agentId: 'agent-b',
    invocationId: 'third',
    toolName: 'exec',
    input: { command: 'three' }
  })

  expect(launcher.launches.map((entry: { agentId: string }) => entry.agentId)).toEqual([
    'agent-a',
    'agent-b'
  ])
  await registry.close()
})

test('registry reports each ready sandbox generation once', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const starts: object[] = []
  const launcher = createFakeLauncher()
  const registry = createRegistry({
    launcher,
    onStart(start: object) {
      starts.push(start)
    }
  })

  await registry.invoke({
    agentId: 'agent-a',
    invocationId: 'first',
    toolName: 'exec',
    input: {}
  })
  await registry.ready('agent-a')
  await launcher.crash('agent-a')
  await registry.ready('agent-a')

  expect(starts).toEqual([
    {
      agentId: 'agent-a',
      generation: 1,
      processId: 1
    },
    {
      agentId: 'agent-a',
      generation: 2,
      processId: 2
    }
  ])
  await registry.close()
})

test('unexpected exit restarts lazily with a monotonic generation', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  const first = await registry.ready('agent-a')
  await launcher.crash('agent-a')
  const second = await registry.ready('agent-a')

  expect(first.generation).toBe(1)
  expect(second.generation).toBe(2)
  await registry.close()
})

test('registry tears down an idle agent and restarts it lazily', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher, idleTimeoutMs: 20 })
  await registry.invoke({
    agentId: 'idle-agent',
    invocationId: 'first',
    toolName: 'exec',
    input: {}
  })
  await waitFor(() => launcher.closes.length === 1)
  const restarted = await registry.ready('idle-agent')

  expect(launcher.closes).toEqual([
    { agentId: 'idle-agent', generation: 1 }
  ])
  expect(restarted.generation).toBe(2)
  await registry.close()
})

test('idle closing removes the old slot before awaiting process close', async () => {
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createRegistry).toBe('function')
  if (typeof createRegistry !== 'function') return

  const closeStarted = deferred<void>()
  const releaseClose = deferred<void>()
  const launches: number[] = []
  const launcher = {
    async launch(input: { agentId: string; generation: number }) {
      launches.push(input.generation)
      const exit = deferred<{ code: number | null; signal: string | null }>()
      return {
        agentId: input.agentId,
        generation: input.generation,
        exited: exit.promise,
        async cleanup() {},
        sandbox: fakeSandbox(input.generation, async () => {
          if (input.generation === 1) {
            closeStarted.resolve()
            await releaseClose.promise
          }
          exit.resolve({ code: 0, signal: null })
        })
      }
    }
  }
  const registry = createRegistry({ launcher, idleTimeoutMs: 20 })
  await registry.invoke({
    agentId: 'replacing-agent',
    invocationId: 'first',
    toolName: 'exec',
    input: {}
  })
  await closeStarted.promise

  const replacement = await registry.ready('replacing-agent')
  expect(replacement.generation).toBe(2)
  expect(launches).toEqual([1, 2])

  releaseClose.resolve()
  await registry.close()
})

test('registry never tears down active work and resets idle time after completion', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const result = deferred<ToolSandboxResult>()
  const launcher = createFakeLauncher({
    invoke(input: { generation: number; invocationId: string }) {
      return result.promise
    }
  })
  const registry = createRegistry({ launcher, idleTimeoutMs: 20 })
  const active = registry.invoke({
    agentId: 'busy-agent',
    invocationId: 'active',
    toolName: 'exec',
    input: {}
  })
  await launcher.waitForInvocation('active')
  await Bun.sleep(50)
  expect(launcher.closes).toEqual([])

  result.resolve({
    status: 'success',
    invocationId: 'active',
    generation: 1,
    value: 'done'
  })
  await active
  await Bun.sleep(10)
  expect(launcher.closes).toEqual([])
  await waitFor(() => launcher.closes.length === 1)
  expect(launcher.closes).toEqual([
    { agentId: 'busy-agent', generation: 1 }
  ])
  await registry.close()
})

test('registry rejects a stale result from an old generation', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const oldResult = deferred<ToolSandboxResult>()
  const launcher = createFakeLauncher({
    invoke(input: { generation: number; invocationId: string }) {
      if (input.generation === 1) return oldResult.promise
      return Promise.resolve({
        status: 'success',
        invocationId: input.invocationId,
        generation: input.generation,
        value: 'fresh'
      })
    }
  })
  const registry = createRegistry({ launcher })
  const stale = registry.invoke({
    agentId: 'agent-a',
    invocationId: 'old',
    toolName: 'exec',
    input: {}
  })
  await launcher.waitForInvocation('old')
  await launcher.crash('agent-a')
  const fresh = await registry.invoke({
    agentId: 'agent-a',
    invocationId: 'new',
    toolName: 'exec',
    input: {}
  })
  oldResult.resolve({
    status: 'success',
    invocationId: 'old',
    generation: 1,
    value: 'stale'
  })

  expect(fresh).toMatchObject({ status: 'success', generation: 2, value: 'fresh' })
  await expect(stale).rejects.toThrow(/stale sandbox result/i)
  await registry.close()
})

test('cancel reaches only the matching child invocation and generation', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const launcher = createFakeLauncher({ holdInvocations: true })
  const registry = createRegistry({ launcher })
  const first = registry.invoke({
    agentId: 'agent-a',
    invocationId: 'same',
    toolName: 'exec',
    input: {}
  })
  const second = registry.invoke({
    agentId: 'agent-b',
    invocationId: 'same',
    toolName: 'exec',
    input: {}
  })
  await Promise.all([
    launcher.waitForInvocation('same', 'agent-a'),
    launcher.waitForInvocation('same', 'agent-b')
  ])

  await registry.cancel({ agentId: 'agent-a', invocationId: 'same' })
  expect(launcher.cancellations).toEqual([
    { agentId: 'agent-a', invocationId: 'same', generation: 1 }
  ])

  await registry.close()
  await Promise.allSettled([first, second])
})

test('sandbox crash is observable without terminating the caller', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const exits: Array<{
    agentId: string
    generation: number
    code: number | null
    signal: string | null
    expected: boolean
  }> = []
  const launcher = createFakeLauncher()
  const registry = createRegistry({
    launcher,
    onExit(exit: {
      agentId: string
      generation: number
      code: number | null
      signal: string | null
      expected: boolean
    }) {
      exits.push(exit)
    }
  })
  await registry.ready('agent-a')
  await launcher.crash('agent-a', { code: 23, signal: null })
  await Promise.resolve()

  expect(exits).toEqual([
    {
      agentId: 'agent-a',
      generation: 1,
      code: 23,
      signal: null,
      expected: false
    }
  ])
  expect(true).toBe(true)
  await registry.close()
})

test('registry close drains every sandbox child', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  if (typeof createFakeLauncher !== 'function' || typeof createRegistry !== 'function') return

  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  await registry.ready('agent-a')
  await registry.ready('agent-b')
  await registry.close()

  expect(launcher.closes).toEqual([
    { agentId: 'agent-a', generation: 1 },
    { agentId: 'agent-b', generation: 1 }
  ])
})

test('rejected exit and cleanup failure are surfaced without blocking restart', async () => {
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createRegistry).toBe('function')
  if (typeof createRegistry !== 'function') return

  const firstExit = deferred<{ code: number | null; signal: string | null }>()
  const secondExit = deferred<{ code: number | null; signal: string | null }>()
  const exits: ObservedExit[] = []
  let cleanupAttempts = 0
  const launcher = {
    async launch(input: { agentId: string; generation: number }) {
      const exit = input.generation === 1 ? firstExit : secondExit
      return {
        agentId: input.agentId,
        generation: input.generation,
        exited: exit.promise,
        async cleanup() {
          cleanupAttempts++
          if (cleanupAttempts === 1) throw new Error('cleanup failed once')
        },
        sandbox: fakeSandbox(input.generation, async () => {
          exit.resolve({ code: 0, signal: null })
        })
      }
    }
  }
  const registry = createRegistry({
    launcher,
    onExit(exit: ObservedExit) {
      exits.push(exit)
    }
  })

  await registry.ready('agent-a')
  firstExit.reject(new Error('exit observation failed'))
  await settleMicrotasks()
  const restarted = await registry.ready('agent-a')

  expect(restarted.generation).toBe(2)
  expect(cleanupAttempts).toBe(2)
  expect(exits).toHaveLength(1)
  expect(exits[0]?.exitError?.message).toBe('exit observation failed')
  expect(exits[0]?.cleanupError?.message).toBe('cleanup failed once')
  await registry.close()
})

test('registry close settles all children, retries cleanup, then aggregates errors', async () => {
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createRegistry).toBe('function')
  if (typeof createRegistry !== 'function') return

  const closes: string[] = []
  const cleanupAttempts = new Map<string, number>()
  const launcher = {
    async launch(input: { agentId: string; generation: number }) {
      const exit = deferred<{ code: number | null; signal: string | null }>()
      return {
        agentId: input.agentId,
        generation: input.generation,
        exited: exit.promise,
        async cleanup() {
          const attempts = (cleanupAttempts.get(input.agentId) ?? 0) + 1
          cleanupAttempts.set(input.agentId, attempts)
          if (input.agentId === 'agent-b') {
            throw new Error(`cleanup-b-${attempts}`)
          }
        },
        sandbox: fakeSandbox(input.generation, async () => {
          closes.push(input.agentId)
          exit.resolve({ code: 0, signal: null })
          throw new Error(`close-${input.agentId}`)
        })
      }
    }
  }
  const registry = createRegistry({ launcher })
  await registry.ready('agent-a')
  await registry.ready('agent-b')

  let closeError: Error | undefined
  try {
    await registry.close()
  } catch (error) {
    closeError = error instanceof Error ? error : new Error(String(error))
  }

  expect(closeError).toBeInstanceOf(AggregateError)
  const closeMessages =
    closeError instanceof AggregateError
      ? closeError.errors.map((error) =>
          error instanceof Error ? error.message : String(error)
        )
      : []
  expect(closeMessages).toEqual(
    expect.arrayContaining(['close-agent-a', 'close-agent-b'])
  )
  expect(closeMessages.some((message) => message.startsWith('cleanup-b-'))).toBe(
    true
  )
  expect(closes.sort()).toEqual(['agent-a', 'agent-b'])
  expect(cleanupAttempts.get('agent-a')).toBeGreaterThanOrEqual(1)
  expect(cleanupAttempts.get('agent-b')).toBeGreaterThanOrEqual(2)
  await expect(registry.ready('agent-a')).rejects.toThrow(/closed/i)
})

test('registry close owns a launch that completes after closure begins', async () => {
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  expect(typeof createRegistry).toBe('function')
  if (typeof createRegistry !== 'function') return

  const launchRequested = deferred<void>()
  const pendingLaunch = deferred<{
    agentId: string
    generation: number
    exited: Promise<{ code: number | null; signal: string | null }>
    cleanup(): Promise<void>
    sandbox: ReturnType<typeof fakeSandbox>
  }>()
  const exit = deferred<{ code: number | null; signal: string | null }>()
  let childAlive = true
  let artifactPresent = true
  let cleanupAttempts = 0
  const launcher = {
    async launch() {
      launchRequested.resolve()
      return pendingLaunch.promise
    }
  }
  const registry = createRegistry({ launcher })
  const readyResult = registry.ready('agent-a').catch((error: Error) => error)
  await launchRequested.promise
  const firstClose = registry.close().catch((error: Error) => error)
  await settleMicrotasks()
  pendingLaunch.resolve({
    agentId: 'agent-a',
    generation: 1,
    exited: exit.promise,
    async cleanup() {
      cleanupAttempts++
      if (cleanupAttempts < 3) {
        throw new Error(`transient artifact cleanup ${cleanupAttempts}`)
      }
      artifactPresent = false
    },
    sandbox: fakeSandbox(1, async () => {
      childAlive = false
      exit.resolve({ code: 0, signal: null })
      throw new Error('transient sandbox close failure')
    })
  })

  const [readyError, firstCloseError] = await Promise.all([
    readyResult,
    firstClose
  ])
  const firstCloseMessages =
    firstCloseError instanceof AggregateError
      ? firstCloseError.errors.map((error) =>
          error instanceof Error ? error.message : String(error)
        )
      : []
  expect(readyError).toBeInstanceOf(Error)
  expect(
    readyError instanceof Error ? readyError.message : ''
  ).toMatch(/registry is closed/i)
  expect(firstCloseMessages).toEqual(
    expect.arrayContaining([
      'transient sandbox close failure',
      'transient artifact cleanup 2'
    ])
  )
  expect(
    firstCloseMessages.some((message) => /registry is closed/i.test(message))
  ).toBe(false)
  expect(childAlive).toBe(false)
  expect(artifactPresent).toBe(true)
  expect(cleanupAttempts).toBe(2)

  await registry.close()
  expect(cleanupAttempts).toBe(3)
  expect(artifactPresent).toBe(false)
})

test('broker routes side effects to sandboxes and shared tools to injection', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  const createBroker = Reflect.get(Harness, 'createSandboxToolBroker')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  expect(typeof createBroker).toBe('function')
  if (
    typeof createFakeLauncher !== 'function' ||
    typeof createRegistry !== 'function' ||
    typeof createBroker !== 'function'
  ) {
    return
  }

  const sharedCalls: string[] = []
  const sharedBroker = {
    async execute(input: { call: { name: string } }) {
      sharedCalls.push(input.call.name)
      return 'shared-result'
    },
    async cancel() {},
    async close() {}
  }
  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  const broker = createBroker({
    registry,
    sandboxTools: ['exec'],
    sharedBroker
  })
  const invocation = {
    agentId: 'agent-a',
    runId: 'run-a',
    operationId: 'operation-a',
    call: { id: 'call-a', name: 'exec', arguments: { command: 'status' } },
    grants: [{ name: 'exec', scope: 'obsidian' }],
    signal: new AbortController().signal
  }

  await broker.execute(invocation)
  await broker.execute({
    ...invocation,
    operationId: 'operation-b',
    call: { id: 'call-b', name: 'generate_image', arguments: { prompt: 'sky' } }
  })

  expect(launcher.invocations.map((entry: { toolName: string }) => entry.toolName)).toEqual(['exec'])
  expect(sharedCalls).toEqual(['generate_image'])
  await broker.close()
})

test('desktop broker denies Obsidian approval before child invocation', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  const createBroker = Reflect.get(Harness, 'createDesktopSkillBroker')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  expect(typeof createBroker).toBe('function')
  if (
    typeof createFakeLauncher !== 'function' ||
    typeof createRegistry !== 'function' ||
    typeof createBroker !== 'function'
  ) {
    return
  }

  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  const broker = createBroker({
    registry,
    approval: { approve: async () => false }
  })
  const invocation = {
    agentId: 'obsidian-agent',
    runId: 'approval-run',
    operationId: 'approval-operation',
    call: {
      id: 'approval-call',
      name: 'exec',
      arguments: { command: 'obsidian version' }
    },
    grants: [{ name: 'exec', scope: 'obsidian' }],
    signal: new AbortController().signal
  }

  await expect(broker.execute(invocation)).rejects.toThrow(/approval denied/i)
  expect(launcher.launches).toEqual([])
  expect(launcher.invocations).toEqual([])
  await broker.close()
})

test('desktop broker never routes image generation or unknown tools to its child', async () => {
  const createFakeLauncher = Reflect.get(Harness, 'createFakeToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  const createBroker = Reflect.get(Harness, 'createDesktopSkillBroker')
  expect(typeof createFakeLauncher).toBe('function')
  expect(typeof createRegistry).toBe('function')
  expect(typeof createBroker).toBe('function')
  if (
    typeof createFakeLauncher !== 'function' ||
    typeof createRegistry !== 'function' ||
    typeof createBroker !== 'function'
  ) {
    return
  }

  const sharedCalls: string[] = []
  const launcher = createFakeLauncher()
  const registry = createRegistry({ launcher })
  const broker = createBroker({
    registry,
    approval: { approve: async () => true },
    sharedBroker: {
      async execute(input: { call: { name: string } }) {
        sharedCalls.push(input.call.name)
        return { shared: true }
      },
      async cancel() {},
      async close() {}
    }
  })
  const invocation = {
    agentId: 'agent-a',
    runId: 'run-a',
    operationId: 'operation-a',
    call: {
      id: 'call-a',
      name: 'generate_image',
      arguments: { prompt: 'sky' }
    },
    grants: [{ name: 'generate_image', scope: null }],
    signal: new AbortController().signal
  }

  await broker.execute(invocation)
  await broker.execute({
    ...invocation,
    operationId: 'operation-b',
    call: { id: 'call-b', name: 'missing_tool', arguments: {} }
  })

  expect(launcher.invocations).toEqual([])
  expect(sharedCalls).toEqual(['generate_image', 'missing_tool'])
  await broker.close()
})

test('launcher sends child secrets over HRPC instead of argv, env, or profile', async () => {
  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  const serve = Reflect.get(Harness, 'serveToolSandbox')
  expect(typeof createLauncher).toBe('function')
  expect(typeof duplexPair).toBe('function')
  expect(typeof serve).toBe('function')
  if (
    typeof createLauncher !== 'function' ||
    typeof duplexPair !== 'function' ||
    typeof serve !== 'function'
  ) {
    return
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'qvac-secret-config-test-'))
  const bareExecutable = path.join(root, 'bare')
  const childEntry = path.join(root, 'child.bundle')
  await writeFile(bareExecutable, '')
  await writeFile(childEntry, '')
  const [server, protocol] = duplexPair()
  const secret = 'unguessable-loopback-token'
  let configuredToken = ''
  serve(server, {
    generation: 1,
    processId: 101,
    configure(configuration: {
      weather?: { token?: string }
    }) {
      configuredToken = configuration.weather?.token ?? ''
      return { async invoke() { return null } }
    }
  })
  let spawned = ''
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const fakeIpc = Object.assign(protocol, {
    ready: Promise.resolve(),
    async send() {},
    async terminate() {
      onExit?.(0, null)
      return 0
    }
  })
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    executablePaths: [],
    readOnlyRoots: [],
    writeRoots: [],
    temporaryRoot: root,
    async permissionsForAgent() {
      return {
        configuration: {
          weather: {
            port: 43123,
            token: secret
          }
        }
      }
    },
    spawn(file: string, args: readonly string[], options: object) {
      spawned = JSON.stringify({ file, args, options })
      return {
        stdio: [null, null, null, protocol],
        once(
          _event: 'exit',
          listener: (code: number | null, signal: string | null) => void
        ) {
          onExit = listener
          return this
        },
        kill() {
          onExit?.(null, 'SIGTERM')
        }
      }
    },
    wrap() {
      return Reflect.get({ fakeIpc }, 'fakeIpc')
    }
  })

  const launched = await launcher.launch({ agentId: 'agent-a', generation: 1 })
  await launched.sandbox.ready()
  expect(configuredToken).toBe(secret)
  expect(spawned).not.toContain(secret)
  const artifactDirectory = (await readdir(root)).find((entry) =>
    entry.startsWith('qvac-tool-sandbox-')
  )
  expect(artifactDirectory).toBeDefined()
  if (artifactDirectory) {
    const profile = await readFile(
      path.join(root, artifactDirectory, 'seatbelt.sb'),
      'utf8'
    )
    expect(profile).not.toContain(secret)
  }
  await launched.sandbox.close()
  await rm(root, { recursive: true, force: true })
})

test('launcher startup failure terminates child and removes private artifacts', async () => {
  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  expect(typeof createLauncher).toBe('function')
  expect(typeof duplexPair).toBe('function')
  if (typeof createLauncher !== 'function' || typeof duplexPair !== 'function') return

  const root = await mkdtemp(path.join(os.tmpdir(), 'qvac-launch-failure-test-'))
  const bareExecutable = path.join(root, 'bare')
  const childEntry = path.join(root, 'child.bundle')
  await writeFile(bareExecutable, '')
  await writeFile(childEntry, '')
  const [protocol] = duplexPair()
  let killed = false
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    executablePaths: [],
    readOnlyRoots: [],
    writeRoots: [],
    temporaryRoot: root,
    spawn() {
      return {
        stdio: [null, null, null, protocol],
        once(
          _event: 'exit',
          listener: (code: number | null, signal: string | null) => void
        ) {
          onExit = listener
          return this
        },
        kill() {
          killed = true
          onExit?.(null, 'SIGTERM')
        }
      }
    },
    wrap() {
      throw new Error('fixture wrap failure')
    }
  })

  await expect(
    launcher.launch({ agentId: 'agent-a', generation: 1 })
  ).rejects.toThrow(/fixture wrap failure/)
  expect(killed).toBe(true)
  expect(
    (await readdir(root)).filter((entry) =>
      entry.startsWith('qvac-tool-sandbox-')
    )
  ).toEqual([])
  await rm(root, { recursive: true, force: true })
})

test('launcher reports readiness and cleanup failures without hiding either', async () => {
  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  expect(typeof createLauncher).toBe('function')
  expect(typeof duplexPair).toBe('function')
  if (typeof createLauncher !== 'function' || typeof duplexPair !== 'function') return

  const root = await mkdtemp(path.join(os.tmpdir(), 'qvac-ready-cleanup-test-'))
  const bareExecutable = path.join(root, 'bare')
  const childEntry = path.join(root, 'child.bundle')
  await writeFile(bareExecutable, '')
  await writeFile(childEntry, '')
  const [protocol] = duplexPair()
  const ready = deferred<void>()
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const fakeIpc = Object.assign(protocol, {
    ready: ready.promise,
    async send() {},
    async terminate() {
      onExit?.(1, null)
      return 1
    }
  })
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    executablePaths: [],
    readOnlyRoots: [],
    writeRoots: [],
    temporaryRoot: root,
    spawn() {
      return {
        stdio: [null, null, null, protocol],
        once(
          _event: 'exit',
          listener: (code: number | null, signal: string | null) => void
        ) {
          onExit = listener
          return this
        },
        kill() {
          onExit?.(null, 'SIGTERM')
        }
      }
    },
    wrap() {
      chmodSync(root, 0o500)
      return Reflect.get({ fakeIpc }, 'fakeIpc')
    }
  })
  const launched = await launcher.launch({
    agentId: 'agent-a',
    generation: 1
  })
  ready.reject(new Error('fixture readiness failed'))

  let readinessError: Error | undefined
  try {
    await launched.sandbox.ready()
  } catch (error) {
    readinessError =
      error instanceof Error ? error : new Error(String(error))
  }
  const messages =
    readinessError instanceof AggregateError
      ? readinessError.errors.map((error) =>
          error instanceof Error ? error.message : String(error)
        )
      : []
  expect(messages.some((message) => message.includes('fixture readiness failed'))).toBe(
    true
  )
  expect(
    messages.some((message) =>
      /operation not permitted|permission denied/i.test(message)
    )
  ).toBe(true)

  chmodSync(root, 0o700)
  await launched.cleanup()
  await rm(root, { recursive: true, force: true })
})

test('launcher terminate timeout still removes private artifacts', async () => {
  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const duplexPair = Reflect.get(Harness, 'duplexPair')
  expect(typeof createLauncher).toBe('function')
  expect(typeof duplexPair).toBe('function')
  if (typeof createLauncher !== 'function' || typeof duplexPair !== 'function') return

  const root = await mkdtemp(path.join(os.tmpdir(), 'qvac-timeout-cleanup-test-'))
  const bareExecutable = path.join(root, 'bare')
  const childEntry = path.join(root, 'child.bundle')
  await writeFile(bareExecutable, '')
  await writeFile(childEntry, '')
  const [protocol] = duplexPair()
  const fakeIpc = Object.assign(protocol, {
    ready: Promise.resolve(),
    async send() {},
    async terminate() {
      return undefined
    }
  })
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    executablePaths: [],
    readOnlyRoots: [],
    writeRoots: [],
    temporaryRoot: root,
    spawn() {
      return {
        stdio: [null, null, null, protocol],
        once() {
          return this
        },
        kill() {}
      }
    },
    wrap() {
      return Reflect.get({ fakeIpc }, 'fakeIpc')
    }
  })
  const launched = await launcher.launch({
    agentId: 'agent-a',
    generation: 1
  })

  await expect(launched.sandbox.close()).rejects.toThrow(
    /did not terminate/i
  )
  expect(
    (await readdir(root)).filter((entry) =>
      entry.startsWith('qvac-tool-sandbox-')
    )
  ).toEqual([])
  await rm(root, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

interface ObservedExit {
  readonly agentId: string
  readonly generation: number
  readonly code: number | null
  readonly signal: string | null
  readonly expected: boolean
  readonly exitError?: Error
  readonly cleanupError?: Error
}

function fakeSandbox(generation: number, close: () => Promise<void>) {
  return {
    async configure() {
      return { generation }
    },
    async ready() {
      return {
        component: 'tool-sandbox' as const,
        runtime: 'bare' as const,
        generation,
        processId: generation,
        protocolVersion: 1
      }
    },
    async invoke(input: {
      invocationId: string
      generation: number
      input: Readonly<Record<string, HarnessJsonValue>>
    }) {
      return {
        status: 'success' as const,
        invocationId: input.invocationId,
        generation: input.generation,
        value: input.input
      }
    },
    async cancel() {},
    close
  }
}

async function settleMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(5)
  }
}
