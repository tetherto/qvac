import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_OPTIONS,
  createQvacServeModels,
  normalizeApiKey,
  resolveOptions,
  type QvacServeModel
} from './provider-config.js'

export interface LocalServiceOptions {
  readonly qvacCommand: string
  readonly apiKeyFile: string
  readonly model: string
  readonly host: string
  readonly port: number
  readonly ctxSize: number
  readonly reasoningBudget: number
  readonly tools: boolean
}

export interface LocalServiceServeConfig {
  readonly serve: {
    readonly models: Record<string, QvacServeModel>
  }
}

const LOCAL_SERVICE_OPTIONS = new Set([
  '--qvac-command',
  '--api-key-file',
  '--model',
  '--host',
  '--port',
  '--ctx-size',
  '--reasoning-budget',
  '--tools'
])

function parseOptions(argv: readonly string[]): ReadonlyMap<string, string> {
  const options = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === undefined || !LOCAL_SERVICE_OPTIONS.has(name)) {
      throw new TypeError('Unknown local service option')
    }
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`${name} requires a value`)
    }
    if (options.has(name)) {
      throw new TypeError(`${name} cannot be specified more than once`)
    }
    options.set(name, value)
  }
  return options
}

// A pre-auth OpenClaw install has `localService.args` persisted in openclaw.json
// without `--api-key-file`. Failing closed is deliberate — the launcher must not
// start an unauthenticated serve — so the message has to name the remedy.
function requireApiKeyFile(options: ReadonlyMap<string, string>): string {
  const value = options.get('--api-key-file')
  if (value === undefined) {
    throw new TypeError(
      '--api-key-file requires a value. This QVAC provider entry was created before the managed ' +
        'qvac serve required bearer authentication; re-run `openclaw onboard --auth-choice qvac` ' +
        'to regenerate it.'
    )
  }
  return value
}

function parseNumberOption(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number`)
  return n
}

function parseBooleanOption(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new TypeError(`${name} must be a boolean`)
}

export function parseLocalServiceArgs(argv: readonly string[]): LocalServiceOptions {
  const values = parseOptions(argv)
  return {
    qvacCommand: values.get('--qvac-command') ?? DEFAULT_OPTIONS.qvacCommand,
    apiKeyFile: requireApiKeyFile(values),
    model: values.get('--model') ?? DEFAULT_OPTIONS.model,
    host: values.get('--host') ?? DEFAULT_OPTIONS.host,
    port: parseNumberOption('--port', values.get('--port'), DEFAULT_OPTIONS.port),
    ctxSize: parseNumberOption('--ctx-size', values.get('--ctx-size'), DEFAULT_OPTIONS.ctxSize),
    reasoningBudget: parseNumberOption(
      '--reasoning-budget',
      values.get('--reasoning-budget'),
      DEFAULT_OPTIONS.reasoningBudget
    ),
    tools: parseBooleanOption('--tools', values.get('--tools'), DEFAULT_OPTIONS.tools)
  }
}

export function loadApiKey(keyFile: string): string {
  return normalizeApiKey(readFileSync(keyFile, 'utf8'), 'stored QVAC API key')
}

export function createLocalServiceServeConfig(
  options: LocalServiceOptions
): LocalServiceServeConfig {
  return {
    serve: {
      models: createQvacServeModels(
        resolveOptions({
          model: options.model,
          host: options.host,
          port: options.port,
          qvacCommand: options.qvacCommand,
          ctxSize: options.ctxSize,
          reasoningBudget: options.reasoningBudget,
          tools: options.tools
        })
      )
    }
  }
}

function serveArgs(options: LocalServiceOptions, configPath: string, apiKey: string): string[] {
  return [
    'serve',
    'openai',
    '--config',
    configPath,
    '--host',
    options.host,
    '--port',
    String(options.port),
    '--model',
    options.model,
    '--api-key',
    apiKey
  ]
}

export function buildQvacServeArgs(options: LocalServiceOptions, configPath: string): string[] {
  return serveArgs(options, configPath, loadApiKey(options.apiKeyFile))
}

export function formatSpawnError(error: unknown, command: string): string {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
  const syscall =
    error instanceof Error && 'syscall' in error && typeof error.syscall === 'string'
      ? error.syscall
      : 'unknown'
  return `Failed to start QVAC service: code=${code} syscall=${syscall} command=${command}`
}

const CONFIG_ERROR_CODES = new Set(['EACCES', 'EISDIR', 'ENOENT', 'ENOTDIR', 'EPERM'])

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatLauncherError(error: unknown): string {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (
    error instanceof TypeError ||
    (error instanceof Error && code && CONFIG_ERROR_CODES.has(code))
  ) {
    const message = sanitizeErrorMessage(error.message)
    if (message) return `QVAC local service launcher failed: ${message}`
  }
  return 'QVAC local service launcher failed'
}

export function resolveLocalServiceExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  stopping: boolean
): number | null {
  if (signal !== null) return stopping ? 0 : null
  return code ?? 1
}

async function writeConfig(
  options: LocalServiceOptions
): Promise<{ configPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-openclaw-'))
  const configPath = join(dir, 'qvac.config.json')
  await writeFile(
    configPath,
    `${JSON.stringify(createLocalServiceServeConfig(options), null, 2)}\n`,
    'utf8'
  )

  return {
    configPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

export interface PreparedLocalServiceLaunch {
  readonly configPath: string
  readonly args: string[]
  cleanup: () => Promise<void>
}

// Resolves the key *before* creating the temp config dir, so an unusable key file
// cannot strand one, and unwinds the dir if anything after that throws.
export async function prepareLocalServiceLaunch(
  options: LocalServiceOptions
): Promise<PreparedLocalServiceLaunch> {
  const apiKey = loadApiKey(options.apiKeyFile)
  const generated = await writeConfig(options)
  try {
    return {
      configPath: generated.configPath,
      args: serveArgs(options, generated.configPath, apiKey),
      cleanup: generated.cleanup
    }
  } catch (error) {
    await generated.cleanup()
    throw error
  }
}

async function main(): Promise<void> {
  const options = parseLocalServiceArgs(process.argv.slice(2))
  const launch = await prepareLocalServiceLaunch(options)

  let child: ChildProcess
  try {
    child = spawn(options.qvacCommand, launch.args, { stdio: 'inherit' })
  } catch (error) {
    await launch.cleanup()
    throw error
  }

  let stopping = false
  async function stop(signal: NodeJS.Signals): Promise<void> {
    if (stopping) return
    stopping = true
    child.kill(signal)
    await launch.cleanup()
  }

  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  child.on('error', async (err) => {
    console.error(formatSpawnError(err, options.qvacCommand))
    await launch.cleanup()
    process.exit(1)
  })

  child.on('exit', async (code, signal) => {
    await launch.cleanup()
    const exitCode = resolveLocalServiceExitCode(code, signal, stopping)
    if (exitCode === null && signal !== null) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(exitCode)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(formatLauncherError(error))
    process.exit(1)
  })
}
