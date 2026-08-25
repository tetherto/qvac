import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { HostExitedError, HostListenTimeoutError, HostSpawnFailedError } from './errors.js'
import {
  HANDSHAKE_FD,
  HANDSHAKE_PREFIX,
  parseHostListening,
  type HostListening
} from './managed-serve-handshake.js'
import { hostEnv, type ResolvedOptions } from './options.js'

declare const Bun: { which(cmd: string): string | null } | undefined

export interface SpawnedHost {
  readonly child: ChildProcess
  readonly listening: HostListening
}

function resolveRuntime(options: ResolvedOptions): string {
  if (options.runtime !== undefined) return options.runtime
  if (typeof Bun !== 'undefined') return Bun.which('node') ?? Bun.which('bun') ?? 'node'
  return process.execPath
}

// Spawn the host and resolve on its `QVAC_LISTENING {…}` handshake, which lands
// on a dedicated pipe as soon as the host proxy listens — before the (possibly
// slow) model download. Host stdout carries only logs, hidden unless `debug` /
// `QVAC_DEBUG=1` mirrors them onto OpenCode's stderr.
export function spawnManagedServeHost(params: {
  options: ResolvedOptions
  projectDir: string
}): Promise<SpawnedHost> {
  const { options, projectDir } = params
  const hostPath = join(dirname(fileURLToPath(import.meta.url)), 'managed-serve-host.js')
  const runtime = resolveRuntime(options)

  let child: ChildProcess
  try {
    child = spawn(runtime, [hostPath], {
      cwd: projectDir,
      env: { ...process.env, ...hostEnv(options) },
      // The host (and its serve) tear down on OpenCode exit via the provider's
      // `closeOnParentExit` parent-pid watch, so no stdin death-pact is needed.
      // fd 3 is the handshake channel, kept apart from the log stream.
      stdio: ['ignore', 'pipe', 'inherit', 'pipe']
    })
  } catch (err) {
    return Promise.reject(
      new HostSpawnFailedError(`failed to spawn qvac serve host with "${runtime}"`, err)
    )
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const stdoutPipe = child.stdout
    const handshakePipe = child.stdio[HANDSHAKE_FD] as Readable | null | undefined
    if (stdoutPipe === null || handshakePipe === null || handshakePipe === undefined) {
      child.kill('SIGTERM')
      reject(new HostSpawnFailedError('qvac serve host has no handshake channel'))
      return
    }
    const stdout: Readable = stdoutPipe
    const channel: Readable = handshakePipe

    const logs = createInterface({ input: stdout })
    const handshake = createInterface({ input: channel })
    const timer = setTimeout(
      () => fail(new HostListenTimeoutError(options.listenTimeoutMs)),
      options.listenTimeoutMs
    )

    // Never leave a host (and the serve it owns) running behind a failed startup.
    function fail(err: unknown): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      handshake.close()
      channel.destroy()
      logs.close()
      stdout.destroy()
      child.kill('SIGTERM')
      reject(err)
    }

    handshake.on('line', (line: string) => {
      if (settled || !line.startsWith(HANDSHAKE_PREFIX)) return
      let listening: HostListening
      try {
        listening = parseHostListening(line.slice(HANDSHAKE_PREFIX.length))
      } catch (err) {
        fail(err)
        return
      }
      settled = true
      clearTimeout(timer)
      handshake.close()
      channel.resume()
      resolve({ child, listening })
    })
    logs.on('line', (line: string) => {
      if (options.debug) process.stderr.write(`[qvac] ${line}\n`)
    })
    child.on('error', (err) =>
      fail(new HostSpawnFailedError(`qvac serve host failed to start with "${runtime}"`, err))
    )
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      handshake.close()
      channel.destroy()
      logs.close()
      reject(new HostExitedError(code))
    })
  })
}
