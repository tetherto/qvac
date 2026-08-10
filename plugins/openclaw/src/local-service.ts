import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
      // The offending token is deliberately not echoed: a misaligned argv puts a
      // *value* in this slot, and one of those values can be a credential.
      throw new TypeError(
        `Unknown local service option. Expected one of: ${[...LOCAL_SERVICE_OPTIONS].join(', ')}`
      )
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

// Re-checked on every read, not just at onboarding: the path is long-lived, and
// a key swapped for a symlink or loosened to group-readable between runs would
// otherwise be picked up silently.
export function loadApiKey(keyFile: string): string {
  const stat = lstatSync(keyFile)
  if (!stat.isFile()) {
    throw new TypeError(`QVAC API key path must be a regular file: ${keyFile}`)
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new TypeError(
      `QVAC API key file ${keyFile} is readable beyond its owner. Run \`chmod 600 ${keyFile}\`, ` +
        'or re-run `openclaw onboard --auth-choice qvac` to regenerate it.'
    )
  }
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

// First `@qvac/cli` able to take the key from a file instead of argv.
const MIN_CLI_VERSION_API_KEY_FILE = '0.11.0'

function isAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string): number[] =>
    (value.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const actual = parts(version)
  const wanted = parts(minimum)
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index] ?? 0
    const right = wanted[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

function resolveCliVersion(): string | undefined {
  const require = createRequire(import.meta.url)
  try {
    const pkg = require(require.resolve('@qvac/cli/package.json')) as { version?: string }
    if (typeof pkg.version === 'string') return pkg.version
  } catch {
    // The published CLI ships a string `exports`, so the ./package.json subpath
    // is not resolvable; walk up from the main entry instead.
  }
  try {
    let dir = dirname(require.resolve('@qvac/cli'))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string
          version?: string
        }
        if (pkg.name === '@qvac/cli' && typeof pkg.version === 'string') return pkg.version
      } catch {
        // Not this level; keep walking.
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // CLI not resolvable from here; fall back to the argv form.
  }
  return undefined
}

// `--api-key <key>` puts the credential in the process list, which /proc exposes
// to every local account on Linux. An older CLI rejects `--api-key-file` outright
// and would never start, so support is confirmed before switching. A custom
// `--qvac-command` points somewhere we cannot version, so it keeps the argv form.
export function cliSupportsApiKeyFile(qvacCommand: string): boolean {
  if (qvacCommand !== DEFAULT_OPTIONS.qvacCommand) return false
  const version = resolveCliVersion()
  return version !== undefined && isAtLeast(version, MIN_CLI_VERSION_API_KEY_FILE)
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
    ...(cliSupportsApiKeyFile(options.qvacCommand)
      ? ['--api-key-file', options.apiKeyFile]
      : ['--api-key', apiKey])
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
