import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, after, type TestContext } from 'node:test'
import { writeConfigDir } from './config.js'

// The built CLI entrypoint, run as `node dist/index.js`.
export const CLI_BIN = fileURLToPath(new URL('../../../dist/index.js', import.meta.url))

export interface CliResult {
  stdout: string
  stderr: string
  // stdout + stderr combined.
  output: string
  code: number | null
}

// Run the CLI to completion and capture stdout/stderr/exit code.
export async function runCli(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: process.env
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += String(d)
  })
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })

  const timer = setTimeout(() => {
    child.kill('SIGKILL')
  }, opts.timeoutMs ?? 30_000)
  timer.unref?.()
  try {
    const [code] = (await once(child, 'close')) as [number | null]
    return { stdout, stderr, output: stdout + stderr, code }
  } finally {
    clearTimeout(timer)
  }
}

// Reserve an ephemeral port (bind :0, read it, release) so spawned servers
// don't collide.
export async function getFreePort(): Promise<number> {
  const srv = createServer()
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const { port } = srv.address() as AddressInfo
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

export interface SpawnedServer {
  port: number
  baseUrl: string
  proc: ChildProcess
  stop: () => Promise<void>
  // Combined stdout+stderr captured so far (for asserting startup logs).
  output: () => string
}

// Spawn `serve openai` on a real port, wait until it answers over the socket,
// and register teardown.
export async function startCliServer(
  t: TestContext,
  args: string[],
  opts: { cwd?: string; readyTimeoutMs?: number } = {}
): Promise<SpawnedServer> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [CLI_BIN, 'serve', 'openai', '-p', String(port), ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: process.env
  })
  let captured = ''
  proc.stdout.on('data', (d) => {
    captured += String(d)
  })
  proc.stderr.on('data', (d) => {
    captured += String(d)
  })

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await once(proc, 'close').catch(() => {})
    }
  }
  t.after(stop)

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`serve exited early (code ${proc.exitCode}):\n${captured}`)
    }
    try {
      await fetch(`${baseUrl}/v1/models`)
      return { port, baseUrl, proc, stop, output: () => captured }
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`serve did not become ready within timeout:\n${captured}`)
}

// Write a config dir and spawn the binary against it.
export async function configuredServer(
  t: TestContext,
  config: unknown,
  args: string[] = []
): Promise<SpawnedServer> {
  const dir = await writeConfigDir(t, config)
  return startCliServer(t, args, { cwd: dir })
}

// Describe-scoped spawned server sharing one process across a suite's tests.
// For real-socket fidelity tests (incremental streaming, client-cancel) that
// need a real model and a real transport. Returns a getter for baseUrl.
export function useSpawnedServer(
  config: unknown,
  args: string[] = [],
  readyTimeoutMs = 120_000
): () => string {
  let proc: ChildProcess | undefined
  let baseUrl: string | undefined
  let dir: string | undefined
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qvac-cli-spawn-'))
    await writeFile(join(dir, 'qvac.config.json'), JSON.stringify(config))
    const port = await getFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    proc = spawn(process.execPath, [CLI_BIN, 'serve', 'openai', '-p', String(port)].concat(args), {
      cwd: dir,
      env: process.env
    })
    let stderr = ''
    proc.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`serve exited early (code ${proc.exitCode}):\n${stderr}`)
      }
      try {
        await fetch(`${baseUrl}/v1/models`)
        return
      } catch {
        await sleep(200)
      }
    }
    throw new Error(`spawned serve not ready within timeout:\n${stderr}`)
  })
  after(async () => {
    if (proc !== undefined && proc.exitCode === null) {
      proc.kill('SIGTERM')
      await once(proc, 'close').catch(() => {})
    }
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })
  return () => {
    if (baseUrl === undefined) {
      throw new Error('useSpawnedServer: not started (called outside a test?)')
    }
    return baseUrl
  }
}
