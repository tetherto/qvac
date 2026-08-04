import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  HarnessJsonValue,
  HarnessToolBrokerPort,
  SdkRuntimeEvent,
  SdkRuntimePort
} from '@qvac/harness'
import { createHarness } from '@qvac/harness'
import * as Runner from '../runner.ts'
import {
  parseRunnerConfig,
  preflightRunner,
  runDesktopRunner,
  type DesktopRunnerDependencies,
  type RunnerEvent,
  type RunnerConfig
} from '../runner.ts'

test('parses explicit CLI configuration without local path defaults', () => {
  const config = parseRunnerConfig(
    [
      'image',
      '--qwen-model=/models/qwen.gguf',
      '--diffusion-model=/models/sd.gguf',
      '--diffusion-prediction=v',
      '--attachment-base=/outputs',
      '--bare=/runtime/bare',
      '--sandbox-entry=/app/tool-sandbox.bundle',
      '--timeout-ms=120000'
    ],
    {}
  )

  expect(config).toEqual({
    command: 'image',
    qwenModel: '/models/qwen.gguf',
    diffusion: {
      model: '/models/sd.gguf',
      prediction: 'v'
    },
    attachmentBase: '/outputs',
    bareExecutable: '/runtime/bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    timeoutMs: 120000,
    obsidianApproval: false
  })
  expect(JSON.stringify(config)).not.toContain('/Users/')
})

test('rejects invalid numeric and boolean CLI values', () => {
  expect(() =>
    parseRunnerConfig(['weather', '--timeout-ms=nope'], {})
  ).toThrow('--timeout-ms must be a positive integer')
  expect(() =>
    parseRunnerConfig(['obsidian', '--approve-obsidian=maybe'], {})
  ).toThrow('--approve-obsidian must be true or false')
})

test('bounded preflight command caps output and confirms TERM to KILL exit', async () => {
  const runBoundedCommand = Reflect.get(Runner, 'runBoundedCommand')
  expect(typeof runBoundedCommand).toBe('function')
  if (typeof runBoundedCommand !== 'function') return

  const signals: string[] = []
  let exitListener:
    | ((code: number | null, signal: string | null) => void)
    | undefined
  const streamListeners = new Map<string, (chunk: object | string) => void>()
  const child = {
    stdout: {
      onData(listener: (chunk: object | string) => void) {
        streamListeners.set('stdout', listener)
      }
    },
    stderr: {
      onData(listener: (chunk: object | string) => void) {
        streamListeners.set('stderr', listener)
      }
    },
    onExit(listener: (code: number | null, signal: string | null) => void) {
      exitListener = listener
    },
    onError() {},
    kill(signal: string) {
      signals.push(signal)
      if (signal === 'SIGKILL') {
        queueMicrotask(() => exitListener?.(null, 'SIGKILL'))
      }
    }
  }

  const pending = runBoundedCommand({
    file: '/cli',
    args: ['version'],
    timeoutMs: 5,
    terminationGraceMs: 5,
    outputLimit: 16,
    spawn() {
      queueMicrotask(() => {
        streamListeners.get('stdout')?.('x'.repeat(100))
        streamListeners.get('stderr')?.('y'.repeat(100))
      })
      return child
    }
  })
  const result = await pending

  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(result.timedOut).toBe(true)
  expect(result.confirmedExit).toBe(true)
  expect(result.stdout.length).toBeLessThanOrEqual(16)
  expect(result.stderr.length).toBeLessThanOrEqual(16)
})

test('bounded preflight reports an unconfirmed hung process', async () => {
  const runBoundedCommand = Reflect.get(Runner, 'runBoundedCommand')
  expect(typeof runBoundedCommand).toBe('function')
  if (typeof runBoundedCommand !== 'function') return

  const signals: string[] = []
  const result = await runBoundedCommand({
    file: '/cli',
    args: ['version'],
    timeoutMs: 5,
    terminationGraceMs: 5,
    outputLimit: 16,
    spawn() {
      return {
        stdout: null,
        stderr: null,
        onExit() {},
        onError() {},
        kill(signal: string) {
          signals.push(signal)
        }
      }
    }
  })

  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(result.timedOut).toBe(true)
  expect(result.confirmedExit).toBe(false)
})

test('preflights every configured boundary and canonicalizes paths', async () => {
  const inspected: string[] = []
  const executableInspections: string[] = []
  const commands: Array<{ readonly file: string; readonly args: readonly string[] }> = []
  const config: RunnerConfig = {
    command: 'all',
    qwenModel: '/models/qwen.gguf',
    diffusion: { model: '/models/sd.gguf', prediction: 'v' },
    attachmentBase: '/outputs',
    bareExecutable: '/runtime/bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidian: {
      executablePath: '/usr/local/bin/obsidian',
      vaultRoot: '/vault',
      vaultIdentity: 'Test Vault'
    },
    obsidianApproval: true,
    timeoutMs: 120_000
  }

  const result = await preflightRunner(config, {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect(path) {
      inspected.push(path)
      return path === '/outputs' || path === '/vault'
        ? 'directory'
        : 'file'
    },
    async realpath(path) {
      return `/private${path}`
    },
    async inspectExecutable(path) {
      executableInspections.push(path)
      return { executable: true, native: path.includes('/runtime/bare') }
    },
    async runCommand(file, args) {
      commands.push({ file, args })
      if (file === '/private/runtime/bare') {
        return {
          exitCode: 0,
          stdout: 'QVAC_BARE_RUNTIME_PROBE_V1\n',
          stderr: '',
          timedOut: false,
          confirmedExit: true
        }
      }
      const selector = args.at(-1)
      const stdout = selector === 'info=name'
        ? 'Test Vault\n'
        : selector === 'info=path'
          ? '/vault\n'
          : '1.12.7\n'
      return {
        exitCode: 0,
        stdout,
        stderr: '',
        timedOut: false,
        confirmedExit: true
      }
    }
  })

  expect(result.skills).toEqual([
    'weather',
    'obsidian',
    'image-generation'
  ])
  expect(result.blocked).toEqual([])
  expect(result.config.qwenModel).toBe('/private/models/qwen.gguf')
  expect(result.config.diffusion?.model).toBe('/private/models/sd.gguf')
  expect(result.config.obsidian?.vaultRoot).toBe('/private/vault')
  expect(inspected).toEqual([
    '/usr/bin/sandbox-exec',
    '/runtime/bare',
    '/app/tool-sandbox.bundle',
    '/models/qwen.gguf',
    '/models/sd.gguf',
    '/outputs',
    '/usr/local/bin/obsidian',
    '/vault'
  ])
  expect(executableInspections).toEqual([
    '/private/runtime/bare',
    '/private/usr/local/bin/obsidian'
  ])
  expect(commands).toEqual([
    {
      file: '/private/runtime/bare',
      args: ['/app/bare-probe.ts']
    },
    {
      file: '/private/usr/local/bin/obsidian',
      args: ['version']
    },
    {
      file: '/private/usr/local/bin/obsidian',
      args: ['vault=Test Vault', 'vault', 'info=name']
    },
    {
      file: '/private/usr/local/bin/obsidian',
      args: ['vault=Test Vault', 'vault', 'info=path']
    }
  ])
})

test('all mode records unavailable Obsidian while dedicated mode fails closed', async () => {
  const base: RunnerConfig = {
    command: 'all',
    qwenModel: '/models/qwen.gguf',
    diffusion: { model: '/models/sd.gguf' },
    attachmentBase: '/outputs',
    bareExecutable: '/runtime/bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidianApproval: false,
    timeoutMs: 120_000
  }
  const preflight = {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect(path: string) {
      return path === '/outputs' ? 'directory' as const : 'file' as const
    },
    async realpath(path: string) {
      return path
    },
    async inspectExecutable() {
      return { executable: true, native: true }
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: 'QVAC_BARE_RUNTIME_PROBE_V1\n',
        stderr: '',
        timedOut: false,
        confirmedExit: true
      }
    }
  }

  const available = await preflightRunner(base, preflight)
  expect(available.skills).toEqual(['weather', 'image-generation'])
  expect(available.blocked).toEqual([
    'Obsidian BLOCKED: configure the official CLI, vault root, exact vault identity, and explicit approval'
  ])

  await expect(
    preflightRunner({ ...base, command: 'obsidian' }, preflight)
  ).rejects.toThrow(
    'Obsidian requires the official CLI, vault root, exact vault identity, and explicit approval'
  )
})

test('preflight rejects a script wrapper as the Bare executable', async () => {
  const config: RunnerConfig = {
    command: 'weather',
    qwenModel: '/models/qwen.gguf',
    bareExecutable: '/runtime/bare-wrapper',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidianApproval: false,
    timeoutMs: 120_000
  }

  await expect(preflightRunner(config, {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect() {
      return 'file'
    },
    async realpath(path) {
      return path
    },
    async inspectExecutable() {
      return { executable: true, native: false }
    },
    async runCommand() {
      throw new Error('command probing was not expected')
    }
  })).rejects.toThrow('Bare executable must be a native executable')
})

test('preflight rejects a native executable that is not Bare', async () => {
  const config: RunnerConfig = {
    command: 'weather',
    qwenModel: '/models/qwen.gguf',
    bareExecutable: '/runtime/not-bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidianApproval: false,
    timeoutMs: 120_000
  }

  await expect(preflightRunner(config, {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect() {
      return 'file'
    },
    async realpath(path) {
      return path
    },
    async inspectExecutable() {
      return { executable: true, native: true }
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: 'NOT_BARE\n',
        stderr: '',
        timedOut: false,
        confirmedExit: true
      }
    }
  })).rejects.toThrow('Bare executable runtime probe failed')
})

test('preflight rejects a hung native Bare probe', async () => {
  const config: RunnerConfig = {
    command: 'weather',
    qwenModel: '/models/qwen.gguf',
    bareExecutable: '/runtime/hung-bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidianApproval: false,
    timeoutMs: 120_000
  }

  await expect(preflightRunner(config, {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect() {
      return 'file'
    },
    async realpath(path) {
      return path
    },
    async inspectExecutable() {
      return { executable: true, native: true }
    },
    async runCommand() {
      return {
        exitCode: 124,
        stdout: '',
        stderr: '',
        timedOut: true,
        confirmedExit: true
      }
    }
  })).rejects.toThrow('Bare executable runtime probe failed')
})

test('all mode blocks timed-out Obsidian probes while dedicated mode fails', async () => {
  const config = completePreflight().config
  const port = {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect(path: string) {
      return path === '/outputs' || path === '/vault'
        ? 'directory' as const
        : 'file' as const
    },
    async realpath(path: string) {
      return path
    },
    async inspectExecutable(path: string) {
      return { executable: true, native: path === '/runtime/bare' }
    },
    async runCommand(file: string) {
      if (file === '/runtime/bare') {
        return {
          exitCode: 0,
          stdout: 'QVAC_BARE_RUNTIME_PROBE_V1\n',
          stderr: '',
          timedOut: false,
          confirmedExit: true
        }
      }
      return {
        exitCode: 124,
        stdout: '',
        stderr: '',
        timedOut: true,
        confirmedExit: true
      }
    }
  }

  const available = await preflightRunner(config, port)
  expect(available.skills).toEqual(['weather', 'image-generation'])
  expect(available.blocked).toEqual([
    'Obsidian BLOCKED: official CLI validation failed'
  ])
  expect(available.config.obsidian).toBeUndefined()
  const events: RunnerEvent[] = []
  const result = await runDesktopRunner(
    available,
    {
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event)
      }
    },
    Runner.createSmokeRunnerDependencies()
  )
  expect(result.status).toBe('partial')
  expect(result.runs).toEqual([
    { skill: 'weather', status: 'success' },
    { skill: 'image-generation', status: 'success' }
  ])
  expect(events.some((event) =>
    event.type === 'tool-call' && event.tool === 'http_request'
  )).toBe(true)
  expect(events.some((event) =>
    event.type === 'tool-call' && event.tool === 'generate_image'
  )).toBe(true)
  await expect(
    preflightRunner({ ...config, command: 'obsidian' }, port)
  ).rejects.toThrow('official Obsidian CLI validation failed')
})

test('Obsidian preflight binds exact vault identity to canonical root', async () => {
  const config = { ...completePreflight().config, command: 'obsidian' as const }
  const port = {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect(path: string) {
      return path === '/vault' ? 'directory' as const : 'file' as const
    },
    async realpath(path: string) {
      return path
    },
    async inspectExecutable(path: string) {
      return { executable: true, native: path === '/runtime/bare' }
    },
    async runCommand(file: string, args: readonly string[]) {
      return {
        exitCode: 0,
        stdout: file === '/runtime/bare'
          ? 'QVAC_BARE_RUNTIME_PROBE_V1\n'
          : args.at(-1) === 'info=name'
            ? 'Different Vault\n'
            : args.at(-1) === 'info=path'
              ? '/other-vault\n'
              : '1.12.7\n',
        stderr: '',
        timedOut: false,
        confirmedExit: true
      }
    }
  }

  await expect(preflightRunner(config, port)).rejects.toThrow(
    'configured Obsidian vault identity does not match the official CLI'
  )
})

test('rejects the Electron app binary and old official CLI versions', async () => {
  const config: RunnerConfig = {
    command: 'obsidian',
    qwenModel: '/models/qwen.gguf',
    bareExecutable: '/runtime/bare',
    sandboxEntry: '/app/tool-sandbox.bundle',
    obsidian: {
      executablePath: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
      vaultRoot: '/vault',
      vaultIdentity: 'Vault'
    },
    obsidianApproval: true,
    timeoutMs: 120_000
  }
  const preflight = {
    platform: 'darwin',
    bareProbeEntry: '/app/bare-probe.ts',
    async inspect(path: string) {
      return path === '/vault' ? 'directory' as const : 'file' as const
    },
    async realpath(path: string) {
      return path
    },
    async inspectExecutable(path: string) {
      return {
        executable: true,
        native: path === '/runtime/bare'
      }
    },
    async runCommand(file: string) {
      return {
        exitCode: 0,
        stdout: file === '/runtime/bare'
          ? 'QVAC_BARE_RUNTIME_PROBE_V1\n'
          : '1.11.0',
        stderr: '',
        timedOut: false,
        confirmedExit: true
      }
    }
  }

  await expect(preflightRunner(config, preflight)).rejects.toThrow(
    'Electron app binary is not an official registered Obsidian CLI'
  )

  await expect(
    preflightRunner({
      ...config,
      obsidian: {
        executablePath: '/usr/local/bin/obsidian',
        vaultRoot: '/vault',
        vaultIdentity: 'Vault'
      }
    }, preflight)
  ).rejects.toThrow('Obsidian CLI 1.12.7 or newer is required')
})

test('runs all selected skills through one SDK with structured tool rounds', async () => {
  const events: RunnerEvent[] = []
  const histories: string[][] = []
  const calls: string[] = []
  const closed: string[] = []
  let sdkCreations = 0
  const sdk = createToolCallingSdk(histories, closed)
  const dependencies: DesktopRunnerDependencies = {
    async createSdk() {
      sdkCreations++
      return sdk
    },
    async createImageTooling() {
      let imageClosed = false
      return {
        tools: [tool('generate_image')],
        broker: broker(calls, 'image', {
          status: 'success',
          attachment: {
            id: 'attachment-1',
            path: '/outputs/runtime/run/image.png',
            mimeType: 'image/png',
            byteLength: 1234,
            width: 512,
            height: 512
          }
        }),
        async cleanupAttachments() {},
        async close() {
          if (imageClosed) return
          imageClosed = true
          closed.push('image')
        }
      }
    },
    async createDesktopTooling(input) {
      let desktopClosed = false
      await input.onSandboxEvent({
        type: 'started',
        agentId: 'weather-agent',
        generation: 1,
        processId: 123
      })
      await input.onSandboxEvent({
        type: 'exit',
        agentId: 'weather-agent',
        generation: 1,
        code: 23,
        signal: null,
        expected: false
      })
      await input.onSandboxEvent({
        type: 'started',
        agentId: 'weather-agent',
        generation: 2,
        processId: 124
      })
      const desktopBroker = broker(calls, 'desktop', {
        status: 200,
        body: 'London: +20 C'
      }, input.sharedBroker)
      return {
        tools: [tool('http_request'), tool('exec')],
        broker: desktopBroker,
        async close() {
          if (desktopClosed) return
          desktopClosed = true
          await desktopBroker.close()
          closed.push('desktop')
        }
      }
    },
    now: monotonicClock()
  }
  const result = await runDesktopRunner(
    completePreflight(),
    {
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event)
      }
    },
    dependencies
  )

  expect(sdkCreations).toBe(1)
  expect(calls).toEqual([
    'desktop:http_request',
    'desktop:exec',
    'image:generate_image'
  ])
  expect(histories.filter((history) => history.length >= 4)).toHaveLength(3)
  expect(histories.some((history) =>
    history.some((content) => content.includes('# Weather'))
  )).toBe(true)
  expect(histories.some((history) =>
    history.some((content) => content.includes('# Obsidian'))
  )).toBe(true)
  expect(histories.some((history) =>
    history.some((content) => content.includes('# Image generation'))
  )).toBe(true)
  expect(histories.some((history) =>
    history.includes(
      'Use http_request to get the current weather in London from wttr.in with format=3, then summarize it.'
    )
  )).toBe(true)
  expect(histories.flat()).not.toContain('{{input}}')
  expect(result.status).toBe('success')
  expect(result.runs.map((run) => run.status)).toEqual([
    'success',
    'success',
    'success'
  ])
  expect(result.attachment).toMatchObject({
    mimeType: 'image/png',
    byteLength: 1234,
    width: 512,
    height: 512
  })
  expect(events.filter((event) => event.type === 'sandbox-started').map(
    (event) => event.generation
  )).toEqual([1, 2])
  expect(events.some((event) =>
    event.type === 'sandbox-exit' && event.expected === false
  )).toBe(true)
  expect(
    events
      .filter((event) => event.type === 'model-loaded')
      .map((event) => ({
        runId: event.runId,
        traceId: event.traceId
      }))
  ).toEqual([
    { runId: undefined, traceId: 'desktop-1-weather/respond' },
    { runId: undefined, traceId: 'desktop-2-obsidian/respond' },
    {
      runId: undefined,
      traceId: 'desktop-3-image-generation/respond'
    }
  ])
  expect(events.filter((event) => event.type === 'tool-call').every(
    (event) => typeof event.runId === 'string' &&
      typeof event.agentId === 'string' &&
      typeof event.toolId === 'string'
  )).toBe(true)
  expect(
    events
      .filter((event) => event.type === 'final-response')
      .map((event) => event.message)
  ).toEqual([
    'Bounded final response.',
    'Bounded final response.',
    'Bounded final response.'
  ])
  const serialized = JSON.stringify(events)
  expect(serialized).not.toContain('weather-secret-token')
  expect(serialized).not.toContain('<tool_call>')
  expect(serialized).not.toContain('"image":[137,80,78,71')
  expect(closed.sort()).toEqual(['desktop', 'image', 'sdk'])
})

test('CLI execution emits JSON lines and a concise result', async () => {
  const executeDesktopCli = Reflect.get(Runner, 'executeDesktopCli')
  expect(typeof executeDesktopCli).toBe('function')
  if (typeof executeDesktopCli !== 'function') return

  const jsonLines: string[] = []
  const humanLines: string[] = []
  const calls: string[] = []
  const closed: string[] = []
  const outcome = await executeDesktopCli(
    {
      argv: [
        'weather',
        '--qwen-model=/models/qwen.gguf',
        '--bare=/runtime/bare',
        '--sandbox-entry=/app/tool-sandbox.bundle',
        '--timeout-ms=120000'
      ],
      environment: {},
      signal: new AbortController().signal,
      writeJson(line: string) {
        jsonLines.push(line)
      },
      writeHuman(line: string) {
        humanLines.push(line)
      }
    },
    {
      preflight: {
        platform: 'darwin',
        bareProbeEntry: '/app/bare-probe.ts',
        async inspect() {
          return 'file'
        },
        async realpath(path: string) {
          return path
        },
        async inspectExecutable() {
          return { executable: true, native: true }
        },
        async runCommand() {
          return {
            exitCode: 0,
            stdout: 'QVAC_BARE_RUNTIME_PROBE_V1\n',
            stderr: '',
            timedOut: false,
            confirmedExit: true
          }
        }
      },
      runner: fakeDependencies({ calls, closed })
    }
  )

  expect(outcome.exitCode).toBe(0)
  expect(outcome.result.status).toBe('success')
  expect(jsonLines.length).toBeGreaterThan(0)
  expect(jsonLines.every((line) => {
    const event = JSON.parse(line)
    return typeof event.type === 'string' &&
      typeof event.elapsedMs === 'number'
  })).toBe(true)
  expect(humanLines).toEqual([
    'weather: success (overall success, shutdown 5 ms)'
  ])
})

test('public text redacts file URLs and absolute paths glued to labels', () => {
  const sanitize = Reflect.get(Runner, 'sanitizePublicText')
  expect(typeof sanitize).toBe('function')
  if (typeof sanitize !== 'function') return

  const sanitized = sanitize(
    'open file:///Users/person/private.md error:/private/tmp/data.txt path=/var/db/item glued/private/tmp/hidden.txt'
  )
  expect(sanitized).not.toContain('/Users/')
  expect(sanitized).not.toContain('/private/')
  expect(sanitized).not.toContain('/var/')
  expect(sanitized).not.toContain('/private/tmp/hidden')
  expect(sanitized).toContain('file://[redacted-path]')
  expect(sanitized).toContain('error:[redacted-path]')
  expect(sanitized).toContain('path=[redacted-path]')
})

test('public event serialization allowlists fields and removes all canaries', () => {
  const serialize = Reflect.get(Runner, 'serializePublicRunnerEvent')
  expect(typeof serialize).toBe('function')
  if (typeof serialize !== 'function') return

  const configuredPath = '/private/config/MODEL_PATH_CANARY.gguf'
  const environmentToken = 'ENVIRONMENT_TOKEN_CANARY'
  const rawEvents: RunnerEvent[] = [
    {
      type: 'run-error',
      elapsedMs: 1,
      message: `SDK_ERROR_CANARY ${configuredPath}`
    },
    {
      type: 'final-response',
      elapsedMs: 2,
      message:
        `FINAL_SECRET_TOKEN_CANARY ${configuredPath} ${environmentToken}`
    },
    {
      type: 'tool-result',
      elapsedMs: 3,
      tool: 'http_request',
      result: {
        status: 200,
        body: 'WEATHER_RESULT_TOKEN_CANARY'
      }
    },
    {
      type: 'tool-result',
      elapsedMs: 4,
      tool: 'exec',
      result: {
        exitCode: 0,
        stdout: 'OBSIDIAN_STDOUT_TOKEN_CANARY',
        stderr: 'OBSIDIAN_STDERR_TOKEN_CANARY'
      }
    },
    {
      type: 'tool-result',
      elapsedMs: 5,
      tool: 'generate_image',
      result: {
        status: 'success',
        attachment: {
          id: 'image-id',
          path: '/private/output/ATTACHMENT_PATH_CANARY.png',
          mimeType: 'image/png',
          byteLength: 10,
          width: 512,
          height: 512
        }
      }
    }
  ]
  const raw = JSON.stringify(rawEvents)
  for (const canary of [
    'SDK_ERROR_CANARY',
    'FINAL_SECRET_TOKEN_CANARY',
    'WEATHER_RESULT_TOKEN_CANARY',
    'OBSIDIAN_STDOUT_TOKEN_CANARY',
    'OBSIDIAN_STDERR_TOKEN_CANARY',
    'ATTACHMENT_PATH_CANARY',
    'MODEL_PATH_CANARY',
    environmentToken
  ]) {
    expect(raw).toContain(canary)
  }

  const serialized = rawEvents
    .map((event) => serialize(event, [configuredPath, environmentToken]))
    .join('\n')
  for (const canary of [
    'SDK_ERROR_CANARY',
    'FINAL_SECRET_TOKEN_CANARY',
    'WEATHER_RESULT_TOKEN_CANARY',
    'OBSIDIAN_STDOUT_TOKEN_CANARY',
    'OBSIDIAN_STDERR_TOKEN_CANARY',
    'ATTACHMENT_PATH_CANARY',
    'MODEL_PATH_CANARY',
    environmentToken
  ]) {
    expect(serialized).not.toContain(canary)
  }
  expect(serialized).not.toContain('/private/')
  expect(serialized).toContain('"status":200')
  expect(serialized).toContain('"exitCode":0')
  expect(serialized).toContain('"width":512')
})

test('tool result includes bounded execution timing', async () => {
  const events: RunnerEvent[] = []
  const calls: string[] = []
  const closed: string[] = []
  const preflight = completePreflight()
  await runDesktopRunner(
    {
      ...preflight,
      config: { ...preflight.config, command: 'weather' },
      skills: ['weather']
    },
    {
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event)
      }
    },
    fakeDependencies({ calls, closed })
  )

  expect(events.find((event) => event.type === 'tool-result')?.durationMs).toBe(5)
})

test('deterministic smoke command exercises all fake model and executor paths', async () => {
  const createSmokeRunnerDependencies = Reflect.get(
    Runner,
    'createSmokeRunnerDependencies'
  )
  expect(typeof createSmokeRunnerDependencies).toBe('function')
  if (typeof createSmokeRunnerDependencies !== 'function') return

  const jsonLines: string[] = []
  const outcome = await Runner.executeDesktopCli(
    {
      argv: ['smoke', '--timeout-ms=5000'],
      environment: {},
      signal: new AbortController().signal,
      writeJson(line) {
        jsonLines.push(line)
      },
      writeHuman() {}
    },
    {
      preflight: {
        platform: 'test',
        bareProbeEntry: '/app/bare-probe.ts',
        async inspect() {
          return 'missing'
        },
        async realpath(path) {
          return path
        },
        async inspectExecutable() {
          return { executable: false, native: false }
        },
        async runCommand() {
          return {
            exitCode: 127,
            stdout: '',
            stderr: '',
            timedOut: false,
            confirmedExit: true
          }
        }
      },
      runner: createSmokeRunnerDependencies()
    }
  )

  expect(outcome.exitCode).toBe(0)
  expect(outcome.result.runs).toEqual([
    { skill: 'weather', status: 'success' },
    { skill: 'obsidian', status: 'success' },
    { skill: 'image-generation', status: 'success' }
  ])
  expect(outcome.result.attachment).toMatchObject({
    mimeType: 'image/png',
    width: 512,
    height: 512
  })
  const serialized = jsonLines.join('\n')
  expect(serialized).not.toContain('smoke-weather-token')
  expect(serialized).not.toContain('<tool_call>')
})

test('production dependency composition passes one shared SDK to both tool layers', async () => {
  const createProductionRunnerDependencies = Reflect.get(
    Runner,
    'createProductionRunnerDependencies'
  )
  expect(typeof createProductionRunnerDependencies).toBe('function')
  if (typeof createProductionRunnerDependencies !== 'function') return

  const calls: string[] = []
  const sdk = createToolCallingSdk([], calls)
  const dependencies = createProductionRunnerDependencies({
    async createSdkDirectAdapter(options) {
      calls.push(`sdk:${JSON.stringify(options)}`)
      return sdk
    },
    async createImageGenerationTooling(input: { readonly sdk: SdkRuntimePort }) {
      expect(input.sdk).toBe(sdk)
      calls.push('image')
      return {
        tools: [tool('generate_image')],
        broker: broker(calls, 'image', { ok: true }),
        async cleanupAttachments() {},
        async close() {}
      }
    },
    async createMacOsDesktopSkillTooling(input) {
      expect(input.bareExecutable).toBe('/runtime/bare')
      expect(input.childEntry).toBe('/app/sandbox.bundle')
      expect(input.sharedBroker).toBeDefined()
      expect(input.obsidian?.access).toBe('read-only')
      expect(input.obsidian?.allowedOperations).toEqual([
        'files',
        'search',
        'read',
        'daily:read',
        'version'
      ])
      calls.push('desktop')
      return {
        tools: [tool('http_request'), tool('exec')],
        broker: broker(calls, 'desktop', { ok: true }, input.sharedBroker),
        async close() {}
      }
    }
  })
  const config: RunnerConfig = {
    command: 'image',
    qwenModel: '/models/qwen.gguf',
    diffusion: { model: '/models/sd.gguf', prediction: 'v' },
    attachmentBase: '/outputs',
    bareExecutable: '/runtime/bare',
    sandboxEntry: '/app/sandbox.bundle',
    obsidian: {
      executablePath: '/cli/obsidian',
      vaultRoot: '/vault',
      vaultIdentity: 'Vault'
    },
    obsidianApproval: false,
    timeoutMs: 120_000
  }
  const createdSdk = await dependencies.createSdk(config)
  const image = await dependencies.createImageTooling({
    sdk: createdSdk,
    attachmentRoot: '/outputs'
  })
  await dependencies.createDesktopTooling({
    config,
    selectedSkillsForAgent() {
      return ['weather']
    },
    approval: { async approve() { return true } },
    sharedBroker: image.broker,
    async onSandboxEvent() {}
  })

  expect(calls.slice(0, 3)).toEqual([
    'sdk:{"diffusion":{"model":"/models/sd.gguf","modelConfig":{"prediction":"v"}}}',
    'image',
    'desktop'
  ])
})

test('production runner rejects Obsidian mutation before approval or sandbox launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-runner-read-only-'))
  const bareExecutable = path.join(root, 'bare')
  const sandboxEntry = path.join(root, 'sandbox.bundle')
  const obsidianExecutable = path.join(root, 'obsidian')
  const vaultRoot = path.join(root, 'vault')
  await Promise.all([
    writeFile(bareExecutable, ''),
    writeFile(sandboxEntry, ''),
    writeFile(obsidianExecutable, ''),
    mkdir(vaultRoot)
  ])
  await Promise.all([
    chmod(bareExecutable, 0o700),
    chmod(obsidianExecutable, 0o700)
  ])
  const sdk: SdkRuntimePort = {
    async loadModel() {
      return { modelId: 'fake-model' }
    },
    completion({ requestId, messages }) {
      const hasResult = messages.some((message) => message.role === 'tool')
      return {
        requestId,
        events: (async function* (): AsyncGenerator<SdkRuntimeEvent> {
          if (!hasResult) {
            yield {
              type: 'tool-call',
              id: 'mutation',
              name: 'exec',
              arguments: {
                command: 'obsidian create path=blocked.md content=blocked'
              }
            }
          }
        })()
      }
    },
    async generateImage() {
      throw new Error('not configured')
    },
    async cancel() {},
    async heartbeat() {
      return { ok: true }
    },
    async close() {}
  }
  let approvals = 0
  let sandboxStarts = 0
  const approval = {
    async approve() {
      approvals++
      return true
    }
  }
  const dependencies = Runner.createProductionRunnerDependencies()
  const config: RunnerConfig = {
    command: 'obsidian',
    qwenModel: '/models/qwen.gguf',
    bareExecutable,
    sandboxEntry,
    obsidian: {
      executablePath: obsidianExecutable,
      vaultRoot,
      vaultIdentity: 'Test Vault'
    },
    obsidianApproval: true,
    timeoutMs: 1_000
  }
  const desktop = await dependencies.createDesktopTooling({
    config,
    selectedSkillsForAgent() {
      return ['obsidian']
    },
    approval,
    async onSandboxEvent(event) {
      if (event.type === 'started') sandboxStarts++
    }
  })
  const harness = createHarness({
    sdk,
    tools: desktop.tools,
    toolBroker: desktop.broker,
    toolApproval: approval
  })
  await harness.registerAgent({
    id: 'obsidian-agent',
    model: '/models/qwen.gguf',
    skills: ['obsidian'],
    toolPolicy: {
      allow: ['exec'],
      requireApproval: ['exec']
    }
  })

  const events = []
  for await (const event of harness.runAgent({
    agentId: 'obsidian-agent',
    runId: 'read-only-mutation',
    input: 'Create a note'
  })) {
    events.push(event)
  }

  expect(events.at(-1)?.type).toBe('error')
  expect(approvals).toBe(0)
  expect(sandboxStarts).toBe(0)
  await harness.close()
  await rm(root, { recursive: true, force: true })
})

test('approval denial fails closed and still closes every resource', async () => {
  const calls: string[] = []
  const closed: string[] = []
  const dependencies = fakeDependencies({
    calls,
    closed
  })
  const preflight = completePreflight()
  const result = await runDesktopRunner(
    {
      ...preflight,
      config: {
        ...preflight.config,
        command: 'obsidian',
        obsidianApproval: false
      },
      skills: ['obsidian']
    },
    {
      signal: new AbortController().signal,
      async emit() {}
    },
    dependencies
  )

  expect(result.status).toBe('failed')
  expect(calls).toEqual([])
  expect(closed.sort()).toEqual(['desktop', 'sdk'])
})

test('cancellation fences a late tool result and reports cleanup', async () => {
  const events: RunnerEvent[] = []
  const calls: string[] = []
  const closed: string[] = []
  const controller = new AbortController()
  let release: (() => void) | undefined
  const dependencies = fakeDependencies({
    calls,
    closed,
    async execute() {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { late: true }
    },
    async cancel() {
      release?.()
    }
  })
  const preflight = completePreflight()
  const result = await runDesktopRunner(
    {
      ...preflight,
      config: {
        ...preflight.config,
        command: 'weather'
      },
      skills: ['weather']
    },
    {
      signal: controller.signal,
      async emit(event) {
        events.push(event)
        if (event.type === 'tool-call') controller.abort('test cancellation')
      }
    },
    dependencies
  )

  expect(result.status).toBe('cancelled')
  expect(events.some((event) => event.type === 'tool-result')).toBe(false)
  expect(events.some((event) => event.type === 'run-cancelled')).toBe(true)
  expect(closed.sort()).toEqual(['desktop', 'sdk'])
})

test('hung cleanup phases are bounded and all resources are attempted', async () => {
  const events: RunnerEvent[] = []
  const calls: string[] = []
  const closed: string[] = []
  const dependencies = Object.assign(
    fakeDependencies({
      calls,
      closed,
      sdkCloseDelayMs: 100,
      desktopCloseDelayMs: 100
    }),
    { cleanupTimeoutMs: 5 }
  )
  const preflight = completePreflight()
  const started = Date.now()
  const result = await runDesktopRunner(
    {
      ...preflight,
      config: { ...preflight.config, command: 'weather' },
      skills: ['weather']
    },
    {
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event)
      }
    },
    dependencies
  )
  const elapsed = Date.now() - started

  expect(elapsed).toBeLessThan(80)
  expect(result.status).toBe('failed')
  expect(events.some((event) =>
    event.type === 'cleanup-error' &&
    event.message?.includes('harness timed out') &&
    event.message.includes('desktop timed out') &&
    event.message.includes('sdk timed out')
  )).toBe(true)
})

test('hung cancellation is bounded and fences events after return', async () => {
  const events: RunnerEvent[] = []
  const calls: string[] = []
  const closed: string[] = []
  const controller = new AbortController()
  let releaseExecute: (() => void) | undefined
  let releaseCancel: (() => void) | undefined
  const dependencies = Object.assign(
    fakeDependencies({
      calls,
      closed,
      async execute() {
        await new Promise<void>((resolve) => {
          releaseExecute = resolve
        })
        return { late: true }
      },
      async cancel() {
        await new Promise<void>((resolve) => {
          releaseCancel = resolve
        })
      }
    }),
    {
      cancellationTimeoutMs: 5,
      cleanupTimeoutMs: 5
    }
  )
  setTimeout(() => {
    releaseCancel?.()
    releaseExecute?.()
  }, 100)
  const preflight = completePreflight()
  const started = Date.now()
  const result = await runDesktopRunner(
    {
      ...preflight,
      config: { ...preflight.config, command: 'weather' },
      skills: ['weather']
    },
    {
      signal: controller.signal,
      async emit(event) {
        events.push(event)
        if (event.type === 'tool-call') controller.abort('hung cancellation')
      }
    },
    dependencies
  )
  const eventCountAtReturn = events.length
  const elapsed = Date.now() - started
  await Bun.sleep(120)

  expect(elapsed).toBeLessThan(80)
  expect(result.status).toBe('failed')
  expect(events.some((event) =>
    event.type === 'run-cancelled' &&
    event.message === 'cancellation timed out'
  )).toBe(true)
  expect(events).toHaveLength(eventCountAtReturn)
  expect(events.some((event) => event.type === 'tool-result')).toBe(false)
})

function completePreflight() {
  return {
    config: {
      command: 'all' as const,
      qwenModel: '/models/qwen.gguf',
      diffusion: { model: '/models/sd.gguf', prediction: 'v' as const },
      attachmentBase: '/outputs',
      bareExecutable: '/runtime/bare',
      sandboxEntry: '/app/tool-sandbox.bundle',
      obsidian: {
        executablePath: '/usr/local/bin/obsidian',
        vaultRoot: '/vault',
        vaultIdentity: 'Test Vault'
      },
      obsidianApproval: true,
      timeoutMs: 120_000
    },
    skills: ['weather', 'obsidian', 'image-generation'] as const,
    blocked: []
  }
}

function fakeDependencies(input: {
  readonly calls: string[]
  readonly closed: string[]
  readonly execute?: HarnessToolBrokerPort['execute']
  readonly cancel?: HarnessToolBrokerPort['cancel']
  readonly sdkCloseDelayMs?: number
  readonly desktopCloseDelayMs?: number
}): DesktopRunnerDependencies {
  const sdk = createToolCallingSdk(
    [],
    input.closed,
    input.sdkCloseDelayMs
  )
  return {
    async createSdk() {
      return sdk
    },
    async createImageTooling() {
      throw new Error('image tooling was not expected')
    },
    async createDesktopTooling(options) {
      let desktopClosed = false
      const desktopBroker: HarnessToolBrokerPort = {
        async execute(invocation) {
          input.calls.push(`desktop:${invocation.call.name}`)
          return input.execute
            ? input.execute(invocation)
            : { ok: true }
        },
        async cancel(invocation) {
          await input.cancel?.(invocation)
        },
        async close() {}
      }
      return {
        tools: [tool('http_request'), tool('exec')],
        broker: desktopBroker,
        async close() {
          if (desktopClosed) return
          if (input.desktopCloseDelayMs) {
            await Bun.sleep(input.desktopCloseDelayMs)
          }
          desktopClosed = true
          input.closed.push('desktop')
        }
      }
    },
    now: monotonicClock()
  }
}

function createToolCallingSdk(
  histories: string[][],
  closed: string[],
  closeDelayMs = 0
): SdkRuntimePort {
  let sdkClosed = false
  return {
    async loadModel({ model }) {
      return { modelId: `loaded:${model}` }
    },
    completion({ requestId, messages, tools }) {
      histories.push(messages.map((message) => message.content))
      const hasResult = messages.some((message) => message.role === 'tool')
      const events = (async function* (): AsyncGenerator<SdkRuntimeEvent> {
        if (!hasResult) {
          const selected = tools?.[0]
          if (!selected) throw new Error('fake model received no tool')
          yield {
            type: 'tool-call',
            id: `${requestId}/call`,
            name: selected.name,
            arguments: argumentsFor(selected.name),
            raw: '<tool_call>must-not-be-logged</tool_call>'
          }
          yield {
            type: 'completion-done',
            raw: { fullText: '<tool_call>must-not-be-logged</tool_call>' }
          }
          return
        }
        yield { type: 'content-delta', text: 'Bounded final ' }
        yield { type: 'content-delta', text: 'response.' }
      })()
      return {
        requestId,
        events
      }
    },
    async generateImage() {
      throw new Error('fake SDK image operation should use the injected broker')
    },
    async cancel() {},
    async heartbeat() {
      return { ok: true }
    },
    async close() {
      if (sdkClosed) return
      if (closeDelayMs) await Bun.sleep(closeDelayMs)
      sdkClosed = true
      closed.push('sdk')
    }
  }
}

function argumentsFor(name: string): Readonly<Record<string, HarnessJsonValue>> {
  if (name === 'http_request') {
    return {
      url: 'https://wttr.in/London?format=3',
      method: 'GET'
    }
  }
  if (name === 'exec') return { command: 'obsidian files' }
  return {
    prompt: 'a red sailboat',
    width: 512,
    height: 512,
    steps: 1,
    seed: 424242
  }
}

function tool(name: string) {
  return {
    schema: {
      type: 'function' as const,
      name,
      description: `Fake ${name}`,
      parameters: {
        type: 'object' as const,
        properties: {}
      }
    }
  }
}

function broker(
  calls: string[],
  label: string,
  result: HarnessJsonValue,
  shared?: HarnessToolBrokerPort
): HarnessToolBrokerPort {
  return {
    async execute(input) {
      if (input.call.name === 'generate_image' && shared) {
        return shared.execute(input)
      }
      calls.push(`${label}:${input.call.name}`)
      return result
    },
    async cancel(input) {
      await shared?.cancel(input)
    },
    async close() {
      await shared?.close()
    }
  }
}

function monotonicClock() {
  let value = 0
  return function now() {
    value += 5
    return value
  }
}
