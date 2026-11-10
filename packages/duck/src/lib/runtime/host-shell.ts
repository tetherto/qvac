// The sandbox the coding shell runs in under allowUnsandboxedShell when no real one started:
// each line runs in the host's own shell, with no confinement at all.
import b4a from 'b4a'
import os from 'bare-os'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'
import { PluginRegistry } from '@qvac/harness/plugins'
import type { HarnessPlugin } from '@qvac/harness'

interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: { aborted: boolean; addEventListener(type: 'abort', fn: () => void): void }
}

const SHELL = process.env['SHELL'] || '/bin/sh'
const { SIGKILL, SIGTERM } = os.constants.signals as Record<'SIGKILL' | 'SIGTERM', number>

export function hostShell(): HarnessPlugin {
  return {
    name: 'host-shell',
    api: PluginRegistry.API_VERSION,
    provides: ['sandbox'],
    setup: () => ({
      services: {
        sandbox: {
          name: 'host-shell',
          isolated: false,
          open: async () => ({
            exec,
            start: async (command: string, { cwd }: { cwd?: string } = {}) => start(command, cwd),
            close: async () => {}
          })
        }
      }
    })
  } as unknown as HarnessPlugin
}

// a background job's output goes where its line redirects it, so it gets no pipes to fill
function run(command: string, cwd: string | undefined, env?: Record<string, string>, pipes = true) {
  return spawn(SHELL, ['-c', command], {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...env },
    stdio: pipes ? ['ignore', 'pipe', 'pipe'] : 'ignore'
  })
}

function exec(command: string, { cwd, env, timeoutMs, signal }: ExecOptions = {}) {
  const child = run(command, cwd, env)
  const out: Uint8Array[] = []
  const err: Uint8Array[] = []
  child.stdout!.on('data', (chunk) => out.push(chunk as Uint8Array))
  child.stderr!.on('data', (chunk) => err.push(chunk as Uint8Array))
  let stopped: string | null = null
  const stop = (why: string) => {
    stopped = why
    child.kill(SIGKILL)
  }
  const timer = timeoutMs
    ? setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs)
    : null
  if (signal?.aborted) stop('canceled')
  signal?.addEventListener('abort', () => stop('canceled'))

  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = b4a.toString(b4a.concat(err))
      resolve({
        stdout: b4a.toString(b4a.concat(out)),
        stderr: stopped ? `${stderr}${stderr && '\n'}${stopped}` : stderr,
        exitCode: stopped ? 124 : (code ?? 1)
      })
    })
  })
}

function start(command: string, cwd: string | undefined) {
  const child = run(command, cwd, undefined, false)
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)))

  return {
    exited,
    async stop() {
      child.kill(SIGTERM)
      await exited
    }
  }
}
