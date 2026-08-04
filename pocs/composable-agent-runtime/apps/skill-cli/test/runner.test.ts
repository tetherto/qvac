import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  HarnessAgentRegistration,
  HarnessAbortSignal,
  HarnessEvent,
  HarnessJsonValue
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
    '/runtime/bare',
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
  const calls: string[] = []
  const closed: string[] = []
  let harnessCreations = 0
  const dependencies: DesktopRunnerDependencies = {
    async createHarness() {
      harnessCreations++
      const registrations = new Map<string, HarnessAgentRegistration>()
      return {
        async registerAgent(registration) {
          registrations.set(registration.id, registration)
        },
        async *runAgent({ agentId }): AsyncGenerator<HarnessEvent> {
          const skill = registrations.get(agentId)?.skills[0]
          const name =
            skill === 'weather'
              ? 'http_request'
              : skill === 'obsidian'
                ? 'exec'
                : 'generate_image'
          calls.push(name)
          yield { type: 'tool-call' as const, name, args: {} }
          const result: HarnessJsonValue =
            name === 'generate_image'
              ? {
                  status: 'success',
                  attachment: {
                    id: 'attachment-1',
                    path: '/outputs/runtime/run/image.png',
                    mimeType: 'image/png',
                    byteLength: 1234,
                    width: 512,
                    height: 512
                  }
                }
              : { ok: true }
          yield {
            type: 'tool-result' as const,
            name,
            result
          }
          yield { type: 'content' as const, text: 'Bounded final response.' }
        },
        async close() {
          closed.push('harness')
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

  expect(harnessCreations).toBe(1)
  expect(calls).toEqual(['http_request', 'exec', 'generate_image'])
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
  expect(closed).toEqual(['harness'])
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

test('production dependency composition passes high-level desktop config to Harness', async () => {
  const createProductionRunnerDependencies = Reflect.get(
    Runner,
    'createProductionRunnerDependencies'
  )
  expect(typeof createProductionRunnerDependencies).toBe('function')
  if (typeof createProductionRunnerDependencies !== 'function') return

  let received: Parameters<typeof createHarness>[0]
  const dependencies = createProductionRunnerDependencies({
    createHarness(options) {
      received = options
      return fakePackageHarness()
    }
  })
  const config: RunnerConfig = {
    command: 'image',
    qwenModel: '/models/qwen.gguf',
    diffusion: { model: '/models/sd.gguf', prediction: 'v' },
    attachmentBase: '/outputs',
    bareExecutable: '/runtime/bare',
    obsidian: {
      executablePath: '/cli/obsidian',
      vaultRoot: '/vault',
      vaultIdentity: 'Vault'
    },
    obsidianApproval: false,
    timeoutMs: 120_000
  }
  await dependencies.createHarness(config)
  // Skills are named by this application, not by Harness: the config is a map
  // of opaque per-skill slices keyed by the skill's catalog name.
  expect(received).toMatchObject({
    inference: 'qwen',
    host: {
      bareExecutable: '/runtime/bare',
      skills: {
        weather: {},
        obsidian: {
          access: 'read-only',
          allowedOperations: [
            'files',
            'search',
            'read',
            'daily:read',
            'version'
          ]
        },
        'image-generation': {
          attachmentRoot: '/outputs',
          model: '/models/sd.gguf',
          prediction: 'v'
        }
      }
    }
  })
  expect(received?.workers?.harnessChildEntry).toContain('harness-child-entry.ts')
})

test('production runner delegates read-only Obsidian enforcement to Harness', async () => {
  let received: Parameters<typeof createHarness>[0]
  const dependencies = Runner.createProductionRunnerDependencies({
    createHarness(options) {
      received = options
      return fakePackageHarness()
    }
  })
  await dependencies.createHarness({
    command: 'obsidian',
    qwenModel: '/models/qwen.gguf',
    bareExecutable: '/runtime/bare',
    obsidian: {
      executablePath: '/cli/obsidian',
      vaultRoot: '/vault',
      vaultIdentity: 'Vault'
    },
    obsidianApproval: true,
    timeoutMs: 1_000
  })
  // Skill configuration is an opaque per-skill slice now; Harness never reads
  // inside it, so the runner's read-only policy has to arrive here.
  expect(received?.host?.skills?.obsidian).toMatchObject({
    access: 'read-only',
    allowedOperations: ['files', 'search', 'read', 'daily:read', 'version']
  })
  expect(received?.workers?.harnessChildEntry).toContain('harness-child-entry.ts')
  expect(received?.workers?.toolSandboxChildEntry).toContain(
    'tool-sandbox-child-entry.ts'
  )
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
  expect(closed).toEqual(['harness'])
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
  expect(closed).toEqual(['harness'])
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
    event.message?.includes('harness timed out')
  )).toBe(true)
})

test('cancellation is delegated to Harness and fences events after return', async () => {
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
  expect(result.status).toBe('cancelled')
  expect(events.some((event) =>
    event.type === 'run-cancelled'
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
  readonly execute?: (invocation: FakeInvocation) => Promise<HarnessJsonValue>
  readonly cancel?: (invocation: FakeInvocation) => Promise<void>
  readonly sdkCloseDelayMs?: number
  readonly desktopCloseDelayMs?: number
}): DesktopRunnerDependencies {
  return {
    async createHarness(config) {
      const registrations = new Map<string, HarnessAgentRegistration>()
      return {
        async registerAgent(registration) {
          registrations.set(registration.id, registration)
        },
        async *runAgent({ agentId, runId, signal }) {
          const registration = registrations.get(agentId)
          const name = registration?.skills[0] === 'obsidian' ? 'exec' : 'http_request'
          if (name === 'exec' && !config.obsidianApproval) {
            yield { type: 'error' as const, message: 'Obsidian approval denied' }
            return
          }
          const invocation: FakeInvocation = {
            agentId,
            runId,
            call: { name },
            signal: signal ?? new AbortController().signal
          }
          input.calls.push(`desktop:${name}`)
          yield { type: 'tool-call' as const, name, args: {} }
          const onAbort = () => {
            void input.cancel?.(invocation)
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          try {
            const result = input.execute
              ? await input.execute(invocation)
              : { ok: true }
            if (signal?.aborted) {
              yield { type: 'aborted' as const }
              return
            }
            yield { type: 'tool-result' as const, name, result }
            yield { type: 'content' as const, text: 'Bounded final response.' }
          } finally {
            signal?.removeEventListener('abort', onAbort)
          }
        },
        async close() {
          const delay = Math.max(
            input.sdkCloseDelayMs ?? 0,
            input.desktopCloseDelayMs ?? 0
          )
          if (delay) await Bun.sleep(delay)
          input.closed.push('harness')
        }
      }
    },
    now: monotonicClock()
  }
}

interface FakeInvocation {
  readonly agentId: string
  readonly runId: string
  readonly call: { readonly name: string }
  readonly signal: HarnessAbortSignal
}

function fakePackageHarness(): ReturnType<typeof createHarness> {
  return {
    exited: new Promise(() => {}),
    lifecycle: { suspend: async () => {}, resume: async () => {} },
    runtime: {
      describe: async () => ({
        component: 'harness',
        runtime: 'bare',
        instanceId: 'fake',
        processId: 1,
        contract: 'qvac.harness',
        protocolVersion: 2,
        capabilities: [],
        buildVersion: '0.0.0-poc'
      })
    },
    ready: async () => {},
    listSkills: async () => [],
    registerAgent: async () => {},
    runAgent: async function* () {},
    cancelAgentRun: async () => {},
    readRun: async () => null,
    watchWork: async function* () {},
    watchApprovals: async function* () {},
    resolveApproval: async () => {},
    close: async () => {}
  }
}

function monotonicClock() {
  let value = 0
  return function now() {
    value += 5
    return value
  }
}
