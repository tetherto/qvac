import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
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

// openclaw 2026.8.1 moved plugin-contributed auth choices behind a
// `provider-plugin:` prefix. The plugin supports openclaw >=2026.6.0, so
// remediation text names both forms rather than one that fails on half the
// supported range.
const ONBOARD_COMMAND_HINT =
  '`openclaw onboard --auth-choice provider-plugin:qvac` ' +
  '(on openclaw < 2026.8.1, `--auth-choice qvac`)'

// A pre-auth OpenClaw install has `localService.args` persisted in openclaw.json
// without `--api-key-file`. Failing closed is deliberate — the launcher must not
// start an unauthenticated serve — so the message has to name the remedy.
function requireApiKeyFile(options: ReadonlyMap<string, string>): string {
  const value = options.get('--api-key-file')
  if (value === undefined) {
    throw new TypeError(
      '--api-key-file requires a value. This QVAC provider entry was created before the managed ' +
        'qvac serve required bearer authentication; re-run ' +
        ONBOARD_COMMAND_HINT +
        ' to regenerate it.'
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

// POSIX-only; Windows resolves symlinks below the API and has no equivalent flag.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

// Re-checked on every read, not just at onboarding: the path is long-lived, and
// a key swapped for a symlink or loosened to group-readable between runs would
// otherwise be picked up silently. Checks run against the open descriptor so the
// path cannot be swapped between the check and the read.
export function loadApiKey(keyFile: string): string {
  let fd: number
  try {
    fd = openSync(keyFile, constants.O_RDONLY | NO_FOLLOW)
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ELOOP') {
      throw new TypeError(`QVAC API key path must be a regular file, not a symlink: ${keyFile}`)
    }
    throw error
  }

  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new TypeError(`QVAC API key path must be a regular file: ${keyFile}`)
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new TypeError(
        `QVAC API key file ${keyFile} is readable beyond its owner. Run \`chmod 600 ${keyFile}\`, ` +
          'or re-run ' +
          ONBOARD_COMMAND_HINT +
          ' to regenerate it.'
      )
    }
    return normalizeApiKey(readFileSync(fd, 'utf8'), 'stored QVAC API key')
  } finally {
    closeSync(fd)
  }
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

// Walked up from the entry rather than asked for by subpath: the published CLI
// ships a string `exports`, which makes `@qvac/cli/package.json` unresolvable.
function cliVersionFor(entry: string): string | undefined {
  let dir = dirname(entry)
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
  return undefined
}

export interface ResolvedQvacCli {
  readonly command: string
  readonly baseArgs: readonly string[]
  readonly supportsApiKeyFile: boolean
}

// `--api-key <key>` puts the credential in the process list, which /proc exposes
// to every local account on Linux. An older CLI rejects `--api-key-file` and
// would never start, so the version has to come from the binary that actually
// runs — a bare `qvac` on PATH can be an unrelated global install. Running the
// resolved entry through the current executable keeps the two in step without
// relying on the bin's exec bit. A custom command is unversionable, so it stays
// on argv.
export function resolveQvacCli(qvacCommand: string): ResolvedQvacCli {
  const onPath: ResolvedQvacCli = {
    command: qvacCommand,
    baseArgs: [],
    supportsApiKeyFile: false
  }
  if (qvacCommand !== DEFAULT_OPTIONS.qvacCommand) return onPath

  let entry: string
  try {
    entry = createRequire(import.meta.url).resolve('@qvac/cli')
  } catch {
    // Not installed beside the plugin; PATH is all there is.
    return onPath
  }

  const version = cliVersionFor(entry)
  return {
    command: process.execPath,
    baseArgs: [entry],
    supportsApiKeyFile: version !== undefined && isAtLeast(version, MIN_CLI_VERSION_API_KEY_FILE)
  }
}

export interface QvacLaunch {
  readonly command: string
  readonly args: string[]
}

function qvacLaunch(options: LocalServiceOptions, configPath: string, apiKey: string): QvacLaunch {
  const cli = resolveQvacCli(options.qvacCommand)
  return {
    command: cli.command,
    args: [
      ...cli.baseArgs,
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
      ...(cli.supportsApiKeyFile ? ['--api-key-file', options.apiKeyFile] : ['--api-key', apiKey])
    ]
  }
}

export function buildQvacLaunch(options: LocalServiceOptions, configPath: string): QvacLaunch {
  return qvacLaunch(options, configPath, loadApiKey(options.apiKeyFile))
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
  readonly command: string
  readonly args: string[]
  cleanup: () => Promise<void>
}

// Resolves the key *before* creating the temp config dir, so an unusable key file
// cannot strand one, and unwinds the dir if anything after that throws. The key
// is validated even when it travels to the child by path.
export async function prepareLocalServiceLaunch(
  options: LocalServiceOptions
): Promise<PreparedLocalServiceLaunch> {
  const apiKey = loadApiKey(options.apiKeyFile)
  const generated = await writeConfig(options)
  try {
    const launch = qvacLaunch(options, generated.configPath, apiKey)
    return {
      configPath: generated.configPath,
      command: launch.command,
      args: launch.args,
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
    child = spawn(launch.command, launch.args, { stdio: 'inherit' })
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
    console.error(formatSpawnError(err, launch.command))
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
