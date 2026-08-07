// QVAC managed-serve plugin for OpenCode.
//
// Adding `@qvac/opencode-plugin` to a project's `opencode.json` makes `opencode`
// bring up a local, managed `qvac serve` by itself — no second terminal, no
// static `provider` block, no `QVAC_MODEL=` prefix. On startup the plugin:
//   1. spawns a real node/bun child (the host) that runs managed mode via
//      `@qvac/ai-sdk-provider` (OpenCode's own runtime is its compiled binary,
//      which managed mode cannot spawn its supervisor from);
//   2. waits for managed serve to resolve, then receives its private base URL
//      and API key through the host handshake;
//   3. injects an authenticated OpenAI-compatible `qvac` provider pointed at
//      the host proxy and sets it as this project's default model.
//
// Options come from (lowest to highest precedence) defaults, a `qvac.json` in
// the project dir, the `opencode.json` plugin tuple options, and `QVAC_*` env.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { Config, Hooks, Plugin } from '@opencode-ai/plugin'

import { HostExitedError, HostListenTimeoutError, HostSpawnFailedError } from './errors.js'
import {
  createManagedProviderConfig,
  parseHostListening,
  type HostListening
} from './managed-serve-handshake.js'
import { hostEnv, resolveOptions, type RawOptions, type ResolvedOptions } from './options.js'

declare const Bun: { which(cmd: string): string | null } | undefined

function resolveRuntime(options: ResolvedOptions): string {
  if (options.runtime !== undefined) return options.runtime
  if (typeof Bun !== 'undefined') return Bun.which('node') ?? Bun.which('bun') ?? 'node'
  return process.execPath
}

// Spawn the host and resolve once it prints its private `QVAC_LISTENING {…}`
// handshake after managed serve is healthy. Host milestones stay hidden by
// default so they do not corrupt OpenCode's TUI.
function spawnHost(
  options: ResolvedOptions,
  projectDir: string
): Promise<{ child: ReturnType<typeof spawn>; listening: HostListening }> {
  const hostPath = join(dirname(fileURLToPath(import.meta.url)), 'managed-serve-host.js')
  const runtime = resolveRuntime(options)

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(runtime, [hostPath], {
      cwd: projectDir,
      env: { ...process.env, ...hostEnv(options) },
      // The host (and its serve) tear down on OpenCode exit via the provider's
      // `closeOnParentExit` parent-pid watch, so no stdin death-pact is needed.
      stdio: ['ignore', 'pipe', 'inherit']
    })
  } catch (err) {
    return Promise.reject(
      new HostSpawnFailedError(`failed to spawn qvac serve host with "${runtime}"`, err)
    )
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const stdout = child.stdout
    if (stdout === null) {
      reject(new HostSpawnFailedError('qvac serve host has no stdout pipe'))
      return
    }
    const rl = createInterface({ input: stdout })
    const handshakeTimeoutMs = options.readyTimeoutMs + options.listenTimeoutMs
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new HostListenTimeoutError(handshakeTimeoutMs))
    }, handshakeTimeoutMs)

    rl.on('line', (line: string) => {
      const match = line.match(/^QVAC_LISTENING (.+)$/)
      if (match !== null && !settled) {
        try {
          const info = parseHostListening(match[1] as string)
          settled = true
          clearTimeout(timer)
          resolve({ child, listening: info })
        } catch (err) {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          reject(err)
        }
        return
      }
      if (options.debug) process.stderr.write(`[qvac] ${line}\n`)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new HostExitedError(code))
    })
  })
}

function registerTeardown(child: ReturnType<typeof spawn>): void {
  const stop = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {
      // best effort
    }
  }
  process.once('exit', stop)
  // Shells report signal exits as 128 + signal number.
  process.once('SIGINT', () => {
    stop()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    stop()
    process.exit(143)
  })
}

function injectProvider(cfg: Config, listening: HostListening, options: ResolvedOptions): void {
  const providers = cfg.provider ?? {}
  providers['qvac'] = createManagedProviderConfig(listening, options.readyTimeoutMs)
  cfg.provider = providers

  // Make the managed model this project's default so plain `opencode` uses it,
  // overriding any global default. Scoped to the project that opted in via its
  // opencode.json, so it never leaks into other projects.
  if (options.setDefaultModel) {
    const id = `qvac/${listening.modelId}`
    cfg.model ??= id
    cfg.small_model ??= id
  }
}

// OpenCode's plugin entry. `options` carries the `opencode.json` plugin-tuple
// options; `input.directory` is the project dir we read `qvac.json` from.
export const QvacManagedServe: Plugin = async (input, options) => {
  const resolved = resolveOptions({
    pluginOptions: options as RawOptions | undefined,
    projectDir: input.directory,
    env: process.env
  })

  const { child, listening } = await spawnHost(resolved, input.directory)
  registerTeardown(child)

  const hooks: Hooks = {
    // lunte-disable-next-line require-await
    config: async (cfg: Config): Promise<void> => {
      injectProvider(cfg, listening, resolved)
    }
  }
  return hooks
}

export default QvacManagedServe
