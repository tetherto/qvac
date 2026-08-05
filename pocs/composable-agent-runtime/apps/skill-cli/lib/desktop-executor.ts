import path from '#path'
import Buffer from '#buffer'
import { BUNDLED_SKILLS } from './skills/bundled-skills.ts'
import { buildCliValidatorFromBundle } from './cli-schema.ts'
import type { HarnessJsonValue } from '@qvac/harness/skill-sandbox'
import type {
  ToolSandboxExecutionRequest,
  ToolSandboxExecutor
} from '@qvac/harness/skill-sandbox'
import {
  validateWeatherRequest,
  WEATHER_MAX_RESPONSE_BYTES_LIMIT
} from './weather-proxy.ts'

const OUTPUT_TRUNCATED_SUFFIX = '… [truncated]'
const OUTPUT_TRUNCATED_SUFFIX_BYTES = Buffer.byteLength(
  OUTPUT_TRUNCATED_SUFFIX,
  'utf8'
)
const TERMINATION_GRACE_MS = 250
const OBSIDIAN_TOOLS = ['exec(obsidian)'] as const
const REGISTERED_TOOLS = new Set(['http_request', 'exec'])
const OBSIDIAN_OPERATIONS = new Set([
  'version',
  'files',
  'search',
  'read',
  'create',
  'append',
  'daily:read'
])

export interface DesktopToolConfiguration {
  readonly enabledTools: readonly ('http_request' | 'exec')[]
  readonly scratchRoot: string
  readonly weather?: {
    readonly agentId: string
    readonly port: number
    readonly token: string
    readonly maxResponseBytes: number
  }
  readonly obsidian?: {
    readonly executablePath: string
    readonly vaultRoot: string
    readonly vaultIdentity: string
    readonly cliSocketPath: string
    readonly timeoutMs: number
    readonly maxOutputBytes: number
    readonly access?: 'read-only' | 'read-write'
    readonly allowedOperations?: readonly string[]
  }
}

interface ChildStream {
  on(event: 'data', listener: (chunk: unknown) => void): object
}

interface DesktopChild {
  readonly stdout: ChildStream | null
  readonly stderr: ChildStream | null
  once(
    event: string,
    listener: (
      ...args: readonly (number | string | null | Error)[]
    ) => void
  ): object
  kill(signal?: number | string): void
}

interface DesktopSpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly shell: false
  readonly detached: false
  readonly stdio: readonly ['ignore', 'pipe', 'pipe']
}

interface RunningCommand {
  readonly result: Promise<HarnessJsonValue>
  terminate(message: string): Promise<void>
}

type DesktopSpawn = (
  file: string,
  argv: readonly string[],
  options: DesktopSpawnOptions
) => DesktopChild

interface HttpResponseStream {
  readonly statusCode: number
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): object
  once(event: 'end', listener: () => void): object
  once(event: 'error', listener: (error: Error) => void): object
  destroy(error?: Error): void
}

interface HttpClientRequest {
  once(event: 'error', listener: (error: Error) => void): object
  end(): void
  destroy(error?: Error): void
}

type LoopbackRequest = (
  options: {
    readonly host: '127.0.0.1'
    readonly port: number
    readonly path: string
    readonly method: 'GET'
    readonly agent: false
    readonly headers: Readonly<Record<string, string>>
  },
  onResponse: (response: HttpResponseStream) => void
) => HttpClientRequest

export interface DesktopToolRuntime {
  readonly spawn?: DesktopSpawn
  readonly request?: LoopbackRequest
}

const obsidianValidator = buildCliValidatorFromBundle(
  'obsidian',
  OBSIDIAN_TOOLS,
  BUNDLED_SKILLS
)

export function parseObsidianCommand(
  command: string,
  executablePath: string,
  vaultIdentity: string,
  allowedOperations?: readonly string[]
):
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (!path.isAbsolute(executablePath)) {
    return {
      ok: false,
      error: 'configured Obsidian executable must be absolute'
    }
  }
  const parsed = splitDirectArgv(command)
  if (!parsed.ok) return parsed
  const [executable, ...rawArgv] = parsed.argv
  if (!executable) {
    return {
      ok: false,
      error: 'command must invoke the configured Obsidian executable'
    }
  }
  const executableName = path.basename(executablePath)
  const allowedInvocations = new Set([executablePath, executableName])
  // Official installer 1.12.7+ ships `obsidian-cli`; PATH registration exposes
  // it as `obsidian`. Models and skill docs use the registered name.
  if (executableName === 'obsidian-cli') {
    allowedInvocations.add('obsidian')
    allowedInvocations.add('/usr/local/bin/obsidian')
  }
  if (!allowedInvocations.has(executable)) {
    return {
      ok: false,
      error: 'command must invoke the configured Obsidian executable'
    }
  }
  const identityError = validateVaultIdentity(vaultIdentity)
  if (identityError) return { ok: false, error: identityError }
  const argvWithoutVault = stripMatchingVaultSelector(rawArgv, vaultIdentity)
  if (!argvWithoutVault.ok) return argvWithoutVault
  const argv = argvWithoutVault.argv
  const operation = argv[0]
  if (
    allowedOperations &&
    (!operation || !allowedOperations.includes(operation))
  ) {
    return {
      ok: false,
      error: 'Obsidian operation is denied by the read-only policy'
    }
  }
  if (!obsidianValidator) {
    return { ok: false, error: 'bundled Obsidian CLI schema is unavailable' }
  }
  if (argv.some(isVaultSelector)) {
    return {
      ok: false,
      error: 'model-supplied Obsidian vault selectors are forbidden'
    }
  }
  const validationError = obsidianValidator.check(argv)
  if (validationError) return { ok: false, error: validationError }
  const boundArgv = [`vault=${vaultIdentity}`, ...argv]
  return { ok: true, argv: boundArgv }
}

export function createDesktopToolExecutor(
  rawConfiguration: DesktopToolConfiguration | HarnessJsonValue,
  runtime: DesktopToolRuntime = {}
): ToolSandboxExecutor {
  const configuration = parseDesktopToolConfiguration(rawConfiguration)
  const enabled = new Set(configuration.enabledTools)
  const activeCommands = new Set<RunningCommand>()
  let closed = false

  return {
    async invoke(input) {
      if (closed) throw new Error('desktop tool executor is closed')
      if (!isRegisteredTool(input.toolName) || !enabled.has(input.toolName)) {
        throw new Error(`desktop tool is not registered: ${input.toolName}`)
      }
      if (input.toolName === 'http_request') {
        if (!configuration.weather) {
          throw new Error('Weather proxy is not configured')
        }
        return executeWeather(input, configuration.weather, runtime)
      }
      if (!configuration.obsidian) {
        throw new Error('Obsidian executor is not configured')
      }
      return executeObsidian(
        input,
        configuration.scratchRoot,
        configuration.obsidian,
        runtime,
        activeCommands,
        () => closed
      )
    },
    async close() {
      if (closed && activeCommands.size === 0) return
      closed = true
      await Promise.all(
        [...activeCommands].map((command) =>
          command.terminate('Obsidian executor closed')
        )
      )
    }
  }
}

async function executeWeather(
  request: ToolSandboxExecutionRequest,
  weather: NonNullable<DesktopToolConfiguration['weather']>,
  runtime: DesktopToolRuntime
) {
  const validated = validateWeatherRequest(request.input)
  if (!validated.ok) return { error: validated.error }
  try {
    return await requestWeatherProxy({
      agentId: weather.agentId,
      port: weather.port,
      token: weather.token,
      url: validated.url,
      signal: request.signal,
      maxResponseBytes: weather.maxResponseBytes,
      request: runtime.request ?? (await loadLoopbackRequest())
    })
  } catch (error) {
    return {
      error: request.signal.aborted
        ? 'Weather request cancelled'
        : humanError(error, 'Weather request failed')
    }
  }
}

async function executeObsidian(
  request: ToolSandboxExecutionRequest,
  scratchRoot: string,
  obsidian: NonNullable<DesktopToolConfiguration['obsidian']>,
  runtime: DesktopToolRuntime,
  activeCommands: Set<RunningCommand>,
  isClosed: () => boolean
) {
  const keys = Object.keys(request.input)
  if (
    keys.length !== 1 ||
    keys[0] !== 'command' ||
    typeof request.input.command !== 'string'
  ) {
    return { error: 'Obsidian exec requires only one command string' }
  }
  const parsed = parseObsidianCommand(
    request.input.command,
    obsidian.executablePath,
    obsidian.vaultIdentity,
    obsidian.allowedOperations
  )
  if (!parsed.ok) return { error: parsed.error }
  const spawn = runtime.spawn ?? (await loadDesktopSpawn())
  if (isClosed()) return { error: 'Obsidian executor closed' }
  const command = startDirectCommand({
    file: obsidian.executablePath,
    argv: parsed.argv,
    cwd: obsidian.vaultRoot,
    homeDirectory: path.dirname(obsidian.cliSocketPath),
    scratchRoot,
    timeoutMs: obsidian.timeoutMs,
    maxOutputBytes: obsidian.maxOutputBytes,
    signal: request.signal,
    spawn
  })
  activeCommands.add(command)
  try {
    return await command.result
  } finally {
    activeCommands.delete(command)
  }
}

function startDirectCommand({
  file,
  argv,
  cwd,
  homeDirectory,
  scratchRoot,
  timeoutMs,
  maxOutputBytes,
  signal,
  spawn
}: {
  readonly file: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly homeDirectory: string
  readonly scratchRoot: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal: ToolSandboxExecutionRequest['signal']
  readonly spawn: DesktopSpawn
}): RunningCommand {
  if (signal.aborted) {
    return completedCommand({ error: 'Obsidian command cancelled' })
  }
  let terminate: (message: string) => Promise<void> = async () => {}
  const result = new Promise<HarnessJsonValue>((resolve) => {
    const stdout = createOutputCapture(maxOutputBytes)
    const stderr = createOutputCapture(maxOutputBytes)
    let settled = false
    let exited = false
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let terminationMessage: string | undefined
    let child: DesktopChild
    try {
      child = spawn(file, argv, {
        cwd,
        env: {
          HOME: homeDirectory,
          LANG: 'C',
          PATH: '/usr/bin:/bin',
          TMPDIR: scratchRoot
        },
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ error: humanError(error, 'Obsidian command failed to start') })
      return
    }

    const finish = (value: HarnessJsonValue) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      signal.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const signalChild = (name: 'SIGTERM' | 'SIGKILL') => {
      try {
        child.kill(name)
      } catch {}
    }
    terminate = async (message: string) => {
      if (settled) return
      terminationMessage ??= message
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (terminationTimer === undefined && forceTimer === undefined) {
        signalChild('SIGTERM')
        terminationTimer = setTimeout(() => {
          terminationTimer = undefined
          if (exited || settled) return
          signalChild('SIGKILL')
          forceTimer = setTimeout(() => {
            forceTimer = undefined
            if (!settled) {
              finish({ error: terminationMessage ?? message })
            }
          }, TERMINATION_GRACE_MS)
        }, TERMINATION_GRACE_MS)
      }
      await result.then(() => {})
    }
    const onAbort = () => {
      void terminate('Obsidian command cancelled')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => {
      void terminate(`Obsidian command timed out after ${timeoutMs}ms`)
    }, timeoutMs)

    child.stdout?.on('data', stdout.append)
    child.stderr?.on('data', stderr.append)
    child.once('error', (...args) => {
      exited = true
      finish({
        error: humanError(args[0], 'Obsidian command failed')
      })
    })
    child.once('exit', (...args) => {
      exited = true
      const code = typeof args[0] === 'number' ? args[0] : null
      if (terminationMessage) {
        finish({ error: terminationMessage })
        return
      }
      finish({
        exitCode: code ?? 1,
        stdout: stdout.value(),
        stderr: stderr.value()
      })
    })
  })
  return {
    result,
    terminate(message) {
      return terminate(message)
    }
  }
}

function completedCommand(value: HarnessJsonValue): RunningCommand {
  return {
    result: Promise.resolve(value),
    async terminate() {}
  }
}

function requestWeatherProxy({
  agentId,
  port,
  token,
  url,
  signal,
  maxResponseBytes,
  request
}: {
  readonly agentId: string
  readonly port: number
  readonly token: string
  readonly url: string
  readonly signal: ToolSandboxExecutionRequest['signal']
  readonly maxResponseBytes: number
  readonly request: LoopbackRequest
}): Promise<HarnessJsonValue> {
  if (signal.aborted) {
    return Promise.resolve({ error: 'Weather request cancelled' })
  }
  return new Promise((resolve, reject) => {
    const output = createOutputCapture(proxyJsonCaptureLimit(maxResponseBytes))
    let settled = false
    let responseStatus = 0
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener?.('abort', onAbort)
      fn()
    }
    const client = request(
      {
        host: '127.0.0.1',
        port,
        path: `/agents/${encodeURIComponent(agentId)}/request?url=${encodeURIComponent(url)}`,
        method: 'GET',
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          connection: 'close'
        }
      },
      (response) => {
        responseStatus = response.statusCode
        response.on('data', output.append)
        response.once('error', (error) => finish(() => reject(error)))
        response.once('end', () => {
          finish(() => {
            const parsed = parseProxyResponse(output.value())
            if (responseStatus !== 200 && !hasError(parsed)) {
              resolve({ error: `Weather proxy returned status ${responseStatus}` })
              return
            }
            resolve(parsed)
          })
        })
      }
    )
    const onAbort = () => {
      client.destroy(new Error('Weather request cancelled'))
      finish(() => resolve({ error: 'Weather request cancelled' }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    client.once('error', (error) => finish(() => reject(error)))
    client.end()
  })
}

function parseProxyResponse(body: string): HarnessJsonValue {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { error: 'Weather proxy returned invalid JSON' }
  }
  if (!isRecord(parsed)) return { error: 'Weather proxy returned invalid JSON' }
  if (typeof parsed.error === 'string') return { error: parsed.error }
  if (typeof parsed.status !== 'number' || typeof parsed.body !== 'string') {
    return { error: 'Weather proxy returned an invalid result' }
  }
  return { status: parsed.status, body: parsed.body }
}

function splitDirectArgv(
  command: string
):
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (!command.trim()) return { ok: false, error: 'command is required' }
  if (/[\0\r\n]/.test(command)) {
    return { ok: false, error: 'command must contain exactly one line' }
  }
  const argv: string[] = []
  let token = ''
  let started = false
  let quote: "'" | '"' | null = null

  for (let index = 0; index < command.length; index++) {
    const character = command[index] ?? ''
    if (quote) {
      if (character === quote) {
        quote = null
        continue
      }
      if (quote === '"' && (character === '$' || character === '`')) {
        return { ok: false, error: 'command substitutions are forbidden' }
      }
      if (character === '\\' && quote === '"') {
        const next = command[index + 1]
        if (next === undefined) {
          return { ok: false, error: 'command ends with an escape' }
        }
        token += next
        index++
        continue
      }
      token += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (character === ' ' || character === '\t') {
      if (started) {
        argv.push(token)
        token = ''
        started = false
      }
      continue
    }
    if (';&|<>`$'.includes(character)) {
      return { ok: false, error: 'shell operators and substitutions are forbidden' }
    }
    if (character === '\\') {
      const next = command[index + 1]
      if (next === undefined) {
        return { ok: false, error: 'command ends with an escape' }
      }
      token += next
      started = true
      index++
      continue
    }
    token += character
    started = true
  }
  if (quote) return { ok: false, error: 'command contains an unterminated quote' }
  if (started) argv.push(token)
  const first = argv[0] ?? ''
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
    return { ok: false, error: 'environment prefixes are forbidden' }
  }
  return { ok: true, argv }
}

function createOutputCapture(limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    append(chunk: unknown) {
      if (truncated) return
      const buffer =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk))
      const available = limit - bytes
      if (buffer.byteLength > available) {
        if (available > 0) {
          chunks.push(Buffer.from(buffer.subarray(0, available)))
        }
        bytes = limit
        truncated = true
        return
      }
      chunks.push(buffer)
      bytes += buffer.byteLength
    },
    value() {
      const combined = Buffer.concat(chunks, bytes)
      const decoded = combined.toString('utf8')
      if (
        !truncated &&
        Buffer.byteLength(decoded, 'utf8') <= limit
      ) {
        return decoded
      }
      return formatTruncatedOutput(decoded, limit)
    }
  }
}

function parseDesktopToolConfiguration(
  value: DesktopToolConfiguration | HarnessJsonValue
): DesktopToolConfiguration {
  if (!isRecord(value)) throw new Error('desktop tool configuration must be an object')
  if (
    !Array.isArray(value.enabledTools) ||
    !value.enabledTools.every(
      (tool) => tool === 'http_request' || tool === 'exec'
    )
  ) {
    throw new Error('desktop tool configuration has invalid enabled tools')
  }
  const scratchRoot = absoluteString(value.scratchRoot, 'scratch root')
  const configuration: {
    enabledTools: ('http_request' | 'exec')[]
    scratchRoot: string
    weather?: DesktopToolConfiguration['weather']
    obsidian?: DesktopToolConfiguration['obsidian']
  } = {
    enabledTools: [...value.enabledTools],
    scratchRoot
  }

  if (value.weather !== undefined) {
    if (!isRecord(value.weather)) throw new Error('Weather configuration is invalid')
    const port = positiveInteger(value.weather.port, 'Weather proxy port')
    const agentId = requiredString(
      value.weather.agentId,
      'Weather agent identity'
    )
    if (typeof value.weather.token !== 'string' || !value.weather.token) {
      throw new Error('Weather proxy token is invalid')
    }
    configuration.weather = {
      agentId,
      port,
      token: value.weather.token,
      maxResponseBytes: boundedPositiveInteger(
        value.weather.maxResponseBytes,
        'Weather response limit',
        WEATHER_MAX_RESPONSE_BYTES_LIMIT
      )
    }
  }
  if (value.obsidian !== undefined) {
    if (!isRecord(value.obsidian)) throw new Error('Obsidian configuration is invalid')
    configuration.obsidian = {
      executablePath: absoluteString(
        value.obsidian.executablePath,
        'Obsidian executable'
      ),
      vaultRoot: absoluteString(value.obsidian.vaultRoot, 'Obsidian vault root'),
      vaultIdentity: requiredString(
        value.obsidian.vaultIdentity,
        'Obsidian vault identity'
      ),
      cliSocketPath: absoluteString(
        value.obsidian.cliSocketPath,
        'Obsidian CLI socket'
      ),
      timeoutMs: positiveInteger(value.obsidian.timeoutMs, 'Obsidian timeout'),
      maxOutputBytes: positiveInteger(
        value.obsidian.maxOutputBytes,
        'Obsidian output limit'
      ),
      ...(value.obsidian.allowedOperations === undefined
        ? {}
        : {
            allowedOperations: allowedObsidianOperations(
              value.obsidian.allowedOperations
            )
          })
    }
  }
  if (configuration.enabledTools.includes('http_request') && !configuration.weather) {
    throw new Error('Weather is enabled without proxy configuration')
  }
  if (configuration.enabledTools.includes('exec') && !configuration.obsidian) {
    throw new Error('Obsidian is enabled without executor configuration')
  }
  if (
    configuration.obsidian &&
    configuration.obsidian.maxOutputBytes < OUTPUT_TRUNCATED_SUFFIX_BYTES
  ) {
    throw new Error(
      `Obsidian output limit must be at least ${OUTPUT_TRUNCATED_SUFFIX_BYTES} bytes`
    )
  }
  return configuration
}

async function loadDesktopSpawn(): Promise<DesktopSpawn> {
  const subprocess = await import('bare-subprocess')
  const runtimeSpawn = Reflect.get(subprocess, 'spawn')
  if (typeof runtimeSpawn !== 'function') {
    throw new Error('bare-subprocess did not export spawn')
  }
  return function spawn(file, argv, options) {
    return Reflect.apply(runtimeSpawn, undefined, [
      file,
      [...argv],
      {
        cwd: options.cwd,
        env: { ...options.env },
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ])
  }
}

async function loadLoopbackRequest(): Promise<LoopbackRequest> {
  const http = await import('bare-http1')
  const runtimeRequest = Reflect.get(http, 'request')
  if (typeof runtimeRequest !== 'function') {
    throw new Error('bare-http1 did not export request')
  }
  return function request(options, onResponse) {
    return Reflect.apply(runtimeRequest, undefined, [
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        agent: false,
        headers: { ...options.headers }
      },
      onResponse
    ])
  }
}

function absoluteString(value: HarnessJsonValue | undefined, label: string) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path`)
  }
  return value
}

function positiveInteger(value: HarnessJsonValue | undefined, label: string) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function boundedPositiveInteger(
  value: HarnessJsonValue | undefined,
  label: string,
  maximum: number
) {
  const parsed = positiveInteger(value, label)
  if (parsed > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`)
  }
  return parsed
}

function requiredString(value: HarnessJsonValue | undefined, label: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new Error(`${label} must be a non-empty single-line string`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, HarnessJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function humanError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function isRegisteredTool(
  value: string
): value is 'http_request' | 'exec' {
  return REGISTERED_TOOLS.has(value)
}

function hasError(value: HarnessJsonValue): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string'
}

function isVaultSelector(token: string) {
  return (
    token === 'vault' ||
    token === '--vault' ||
    token === '-vault' ||
    token.startsWith('vault=') ||
    token.startsWith('--vault=') ||
    token.startsWith('-vault=')
  )
}

function stripMatchingVaultSelector(
  argv: readonly string[],
  vaultIdentity: string
):
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (argv.length === 0) return { ok: true, argv }
  const [first, ...rest] = argv
  if (!first || !isVaultSelector(first)) return { ok: true, argv }
  // Official CLI style puts vault=<name> first. Accept only the configured
  // identity, then strip it so the host can inject exactly one trusted copy.
  if (first === `vault=${vaultIdentity}`) {
    if (rest.some(isVaultSelector)) {
      return {
        ok: false,
        error: 'model-supplied Obsidian vault selectors are forbidden'
      }
    }
    return { ok: true, argv: rest }
  }
  return {
    ok: false,
    error: 'model-supplied Obsidian vault selectors are forbidden'
  }
}

function allowedObsidianOperations(value: HarnessJsonValue) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Obsidian allowed operations are invalid')
  }
  const operations: string[] = []
  for (const operation of value) {
    if (
      typeof operation !== 'string' ||
      !OBSIDIAN_OPERATIONS.has(operation)
    ) {
      throw new Error('Obsidian allowed operations are invalid')
    }
    operations.push(operation)
  }
  return operations
}

function validateVaultIdentity(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return 'configured Obsidian vault identity is invalid'
  }
  return null
}

function proxyJsonCaptureLimit(maxResponseBytes: number) {
  return maxResponseBytes * 6 + 128
}

function formatTruncatedOutput(content: string, limit: number) {
  const contentBudget = Math.max(0, limit - OUTPUT_TRUNCATED_SUFFIX_BYTES)
  let value = ''
  let bytes = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > contentBudget) break
    value += character
    bytes += characterBytes
  }
  return `${value}${OUTPUT_TRUNCATED_SUFFIX}`
}
