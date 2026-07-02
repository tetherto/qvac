import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_OPTIONS,
  createQvacServeModels,
  resolveOptions,
  type QvacServeModel
} from './provider-config.js'

export interface LocalServiceOptions {
  readonly qvacCommand: string
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

function readOption (argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined) throw new TypeError(`${name} requires a value`)
  return value
}

function parseNumberOption (name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be a finite number`)
  return n
}

function parseBooleanOption (name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new TypeError(`${name} must be a boolean`)
}

export function parseLocalServiceArgs (argv: readonly string[]): LocalServiceOptions {
  return {
    qvacCommand: readOption(argv, '--qvac-command') ?? DEFAULT_OPTIONS.qvacCommand,
    model: readOption(argv, '--model') ?? DEFAULT_OPTIONS.model,
    host: readOption(argv, '--host') ?? DEFAULT_OPTIONS.host,
    port: parseNumberOption('--port', readOption(argv, '--port'), DEFAULT_OPTIONS.port),
    ctxSize: parseNumberOption('--ctx-size', readOption(argv, '--ctx-size'), DEFAULT_OPTIONS.ctxSize),
    reasoningBudget: parseNumberOption(
      '--reasoning-budget',
      readOption(argv, '--reasoning-budget'),
      DEFAULT_OPTIONS.reasoningBudget
    ),
    tools: parseBooleanOption('--tools', readOption(argv, '--tools'), DEFAULT_OPTIONS.tools)
  }
}

export function createLocalServiceServeConfig (options: LocalServiceOptions): LocalServiceServeConfig {
  return {
    serve: {
      models: createQvacServeModels(resolveOptions({
        model: options.model,
        host: options.host,
        port: options.port,
        qvacCommand: options.qvacCommand,
        ctxSize: options.ctxSize,
        reasoningBudget: options.reasoningBudget,
        tools: options.tools
      }))
    }
  }
}

export function buildQvacServeArgs (options: LocalServiceOptions, configPath: string): string[] {
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
    options.model
  ]
}

export function resolveLocalServiceExitCode (
  code: number | null,
  signal: NodeJS.Signals | null,
  stopping: boolean
): number | null {
  if (signal !== null) return stopping ? 0 : null
  return code ?? 1
}

async function writeConfig (options: LocalServiceOptions): Promise<{ configPath: string, cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-openclaw-'))
  const configPath = join(dir, 'qvac.config.json')
  await writeFile(configPath, `${JSON.stringify(createLocalServiceServeConfig(options), null, 2)}\n`, 'utf8')

  return {
    configPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

async function main (): Promise<void> {
  const options = parseLocalServiceArgs(process.argv.slice(2))
  const generated = await writeConfig(options)
  const child = spawn(options.qvacCommand, buildQvacServeArgs(options, generated.configPath), {
    stdio: 'inherit'
  })

  let stopping = false
  async function stop (signal: NodeJS.Signals): Promise<void> {
    if (stopping) return
    stopping = true
    child.kill(signal)
    await generated.cleanup()
  }

  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  child.on('error', async (err) => {
    console.error(err)
    await generated.cleanup()
    process.exit(1)
  })

  child.on('exit', async (code, signal) => {
    await generated.cleanup()
    const exitCode = resolveLocalServiceExitCode(code, signal, stopping)
    if (exitCode === null && signal !== null) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(exitCode)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
