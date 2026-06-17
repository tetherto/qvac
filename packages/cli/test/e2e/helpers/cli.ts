import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TestContext } from 'node:test'

// The built binary the bats suite runs as `node dist/index.js`.
export const CLI_BIN = fileURLToPath(new URL('../../../dist/index.js', import.meta.url))

export interface CliResult {
  stdout: string
  stderr: string
  // stdout + stderr combined, matching the bats `run` `$output`.
  output: string
  code: number | null
}

// Run the CLI to completion and capture stdout/stderr/exit code.
export async function runCli (args: string[], opts: { cwd?: string, timeoutMs?: number } = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: process.env
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += String(d) })
  child.stderr.on('data', (d) => { stderr += String(d) })

  const timer = setTimeout(() => { child.kill('SIGKILL') }, opts.timeoutMs ?? 30_000)
  timer.unref?.()
  try {
    const [code] = await once(child, 'close') as [number | null]
    return { stdout, stderr, output: stdout + stderr, code }
  } finally {
    clearTimeout(timer)
  }
}

// Reserve an ephemeral port (bind :0, read it, release) so spawned servers
// don't collide.
export async function getFreePort (): Promise<number> {
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
}

// Spawn `serve openai` on a real port, wait until it answers over the socket,
// and register teardown. This is the black-box / real-transport counterpart to
// the in-process app.inject harness.
export async function startCliServer (
  t: TestContext,
  args: string[],
  opts: { cwd?: string, readyTimeoutMs?: number } = {}
): Promise<SpawnedServer> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const proc = spawn(process.execPath, [CLI_BIN, 'serve', 'openai', '-p', String(port), ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: process.env
  })
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += String(d) })

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await once(proc, 'close').catch(() => {})
    }
  }
  t.after(stop)

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`serve exited early (code ${proc.exitCode}):\n${stderr}`)
    try {
      await fetch(`${baseUrl}/v1/models`)
      return { port, baseUrl, proc, stop }
    } catch {
      await sleep(150)
    }
  }
  throw new Error(`serve did not become ready within timeout:\n${stderr}`)
}
