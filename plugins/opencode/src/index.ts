// QVAC managed-serve plugin for OpenCode.
//
// Adding `@qvac/opencode-plugin` to a project's `opencode.json` makes `opencode`
// bring up a local, managed `qvac serve` by itself — no second terminal, no
// static `provider` block, no `QVAC_MODEL=` prefix. On startup the plugin:
//   1. spawns a real node/bun child (the host) that runs managed mode via
//      `@qvac/ai-sdk-provider` (OpenCode's own runtime is its compiled binary,
//      which managed mode cannot spawn its supervisor from);
//   2. waits only for the host's proxy to start listening — not for the model
//      to download — and receives the proxy's base URL and access token over a
//      dedicated handshake pipe;
//   3. injects an authenticated OpenAI-compatible `qvac` provider pointed at
//      the host proxy and sets it as this project's default model.
//
// The managed serve's own key never leaves the host: the proxy authenticates
// OpenCode with the handshake token and swaps in the real key upstream.
//
// Options come from (lowest to highest precedence) defaults, a `qvac.json` in
// the project dir, the `opencode.json` plugin tuple options, and `QVAC_*` env.
import type { ChildProcess } from 'node:child_process'

import type { Config, Hooks, Plugin } from '@opencode-ai/plugin'

import { createManagedProviderConfig, type HostListening } from './managed-serve-handshake.js'
import { resolveOptions, type RawOptions, type ResolvedOptions } from './options.js'
import { spawnManagedServeHost } from './spawn-host.js'

// The handshake lands as soon as the proxy listens, so the host can still fail
// afterwards — an incompatible provider, a serve that never becomes healthy.
// Without this the injected `qvac` provider would just start refusing
// connections with nothing tying that back to the host's own error.
function watchHostExit(child: ChildProcess): void {
  child.once('exit', (code, signal) => {
    if (code === 0 || signal === 'SIGTERM') return
    process.stderr.write(
      `[qvac] managed serve host exited (${code ?? signal ?? 'unknown'}); the qvac provider is no longer available. ` +
        'Restart opencode after resolving the error above.\n'
    )
  })
}

function registerTeardown(child: ChildProcess): void {
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

  const { child, listening } = await spawnManagedServeHost({
    options: resolved,
    projectDir: input.directory
  })
  registerTeardown(child)
  watchHostExit(child)

  const hooks: Hooks = {
    // lunte-disable-next-line require-await
    config: async (cfg: Config): Promise<void> => {
      injectProvider(cfg, listening, resolved)
    }
  }
  return hooks
}

export default QvacManagedServe
