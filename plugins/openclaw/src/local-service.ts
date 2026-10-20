import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

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
  readonly cwd?: string | undefined
  readonly ctxSize: number
  readonly reasoningBudget: number
  readonly tools: boolean
  readonly readyTimeoutMs: number
}

export interface LocalServiceServeConfig {
  readonly serve: {
    readonly models: Record<string, QvacServeModel>
  }
}

// openclaw 2026.8.1 moved plugin-contributed auth choices behind a
// `provider-plugin:` prefix. The plugin supports openclaw >=2026.6.0, so
// remediation text names both forms rather than one that fails on half the
// supported range.
export const ONBOARD_COMMAND_HINT =
  '`openclaw onboard --auth-choice provider-plugin:qvac` ' +
  '(on openclaw < 2026.8.1, `--auth-choice qvac`)'

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
// First `@qvac/cli` able to report the port it bound on an inherited descriptor.
export const MIN_CLI_VERSION_READY_FD = '0.16.0'

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
  readonly version: string | undefined
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
    version: undefined,
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
    version,
    supportsApiKeyFile: version !== undefined && isAtLeast(version, MIN_CLI_VERSION_API_KEY_FILE)
  }
}

export interface QvacLaunch {
  readonly command: string
  readonly args: string[]
}

// The serve writes its bound port to this inherited pipe. Only the child this
// plugin spawned can write to it, so the port it names is never one another
// local process claimed first.
const READY_FD = 3
const READY_PREFIX = 'QVAC_SERVE_READY '

function cliUpgradeError(): TypeError {
  return new TypeError(
    `This @qvac/cli cannot report the port it bound (--ready-fd), so the QVAC plugin cannot ` +
      `verify the local service before sending it a key. Install @qvac/cli ` +
      `${MIN_CLI_VERSION_READY_FD} or newer.`
  )
}

// `--no-default` is part of the pair, not an extra: bare `--openai` also mounts
// the QVAC surface on the port, while the `serve openai` subcommand this
// replaces exposed `/v1/*` alone. Keeping both preserves that and keeps the
// extra surface off a port the plugin authenticates and owns.
function qvacLaunch(options: LocalServiceOptions, configPath: string, apiKey: string): QvacLaunch {
  const cli = resolveQvacCli(options.qvacCommand)
  if (cli.version !== undefined && !isAtLeast(cli.version, MIN_CLI_VERSION_READY_FD)) {
    throw cliUpgradeError()
  }
  return {
    command: cli.command,
    args: [
      ...cli.baseArgs,
      'serve',
      '--openai',
      '--no-default',
      '--config',
      configPath,
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--ready-fd',
      String(READY_FD),
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

export interface PreparedLocalServiceLaunch {
  readonly configPath: string
  readonly command: string
  readonly args: string[]
  cleanup: () => void
}

// Resolves the key *before* creating the temp config dir, so an unusable key file
// cannot strand one, and unwinds the dir if anything after that throws. The key
// is validated even when it travels to the child by path.
export function prepareLocalServiceLaunch(
  options: LocalServiceOptions
): PreparedLocalServiceLaunch {
  const apiKey = loadApiKey(options.apiKeyFile)
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-'))
  function cleanup(): void {
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    const configPath = join(dir, 'qvac.config.json')
    writeFileSync(
      configPath,
      `${JSON.stringify(createLocalServiceServeConfig(options), null, 2)}\n`,
      'utf8'
    )
    const launch = qvacLaunch(options, configPath, apiKey)
    return { configPath, command: launch.command, args: launch.args, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

// Bounded tail of the serve's own output, so a startup failure can say why.
function collectOutputTail(child: ChildProcess, maxChars = 4000): () => string {
  let tail = ''
  function append(chunk: Buffer): void {
    tail = (tail + chunk.toString('utf8')).slice(-maxChars)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => tail
}

function waitForReady(
  child: ChildProcess,
  command: string,
  timeoutMs: number,
  getTail: () => string
): Promise<number> {
  const channel = child.stdio[READY_FD] as Readable | null | undefined
  return new Promise((resolve, reject) => {
    if (channel === null || channel === undefined) {
      reject(new Error('QVAC local service has no ready channel'))
      return
    }
    const lines = createInterface({ input: channel })
    const timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`QVAC local service did not report its port within ${timeoutMs}ms`))
      )
    }, timeoutMs)
    function settle(action: () => void): void {
      clearTimeout(timer)
      lines.close()
      child.off('close', onClose)
      child.off('error', onError)
      action()
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      const tail = getTail()
      if (/unknown option '--ready-fd'/.test(tail)) {
        settle(() => reject(cliUpgradeError()))
        return
      }
      const status = signal === null ? `code ${String(code)}` : `signal ${signal}`
      const detail = tail.trim() === '' ? '' : `\n${tail.trim()}`
      settle(() =>
        reject(new Error(`QVAC local service exited before it was ready (${status})${detail}`))
      )
    }
    function onError(error: unknown): void {
      settle(() => reject(new Error(formatSpawnError(error, command))))
    }
    // `close`, not `exit`: an older CLI's rejection must be in the tail first.
    child.once('close', onClose)
    child.once('error', onError)
    lines.on('line', (line) => {
      if (!line.startsWith(READY_PREFIX)) return
      let signal: { port?: unknown; pid?: unknown }
      try {
        signal = JSON.parse(line.slice(READY_PREFIX.length)) as typeof signal
      } catch {
        return
      }
      if (typeof signal.port !== 'number' || signal.pid !== child.pid) return
      const port = signal.port
      settle(() => resolve(port))
    })
  })
}

export interface VerifiedQvacServe {
  readonly baseUrl: string
  readonly pid: number
}

interface RunningServe {
  readonly fingerprint: string
  readonly child: ChildProcess
  readonly ready: Promise<VerifiedQvacServe>
  stop(): void
}

let running: RunningServe | undefined
let exitHookInstalled = false

function stopRunning(): void {
  running?.stop()
  running = undefined
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', stopRunning)
}

function startServe(options: LocalServiceOptions, fingerprint: string): RunningServe {
  const launch = prepareLocalServiceLaunch(options)
  let child: ChildProcess
  try {
    child = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
  } catch (error) {
    launch.cleanup()
    throw new Error(formatSpawnError(error, launch.command))
  }
  // OpenClaw one-shot commands must still exit when their turn is done; the
  // exit hook then takes the serve down with them.
  child.unref()
  for (const stream of child.stdio) {
    ;(stream as { unref?: () => void } | null)?.unref?.()
  }
  installExitHook()

  const getTail = collectOutputTail(child)
  const entry: RunningServe = {
    fingerprint,
    child,
    ready: waitForReady(child, launch.command, options.readyTimeoutMs, getTail).then((port) => ({
      baseUrl: `http://${formatHost(options.host)}:${port}/v1`,
      pid: child.pid ?? 0
    })),
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      launch.cleanup()
    }
  }
  child.once('exit', () => {
    launch.cleanup()
    if (running === entry) running = undefined
  })
  entry.ready.catch(() => {
    entry.stop()
    if (running === entry) running = undefined
  })
  return entry
}

// Starts `qvac serve` on a port only it can report, and hands back the URL the
// key may be sent to. A serve this process already started is reused while its
// launch options stay the same.
export function ensureQvacServe(options: LocalServiceOptions): Promise<VerifiedQvacServe> {
  const fingerprint = JSON.stringify(options)
  if (running !== undefined && running.fingerprint !== fingerprint) stopRunning()
  running ??= startServe(options, fingerprint)
  return running.ready
}

export function stopQvacServe(): void {
  stopRunning()
}
