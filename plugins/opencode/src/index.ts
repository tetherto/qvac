// QVAC managed-serve plugin for OpenCode 2.x.
//
// Listing `@qvac/opencode-plugin` under `plugins` in a project's opencode config
// makes `opencode` bring up a local, managed `qvac serve` by itself. On setup the
// plugin:
//   1. spawns a real node/bun child (the host) that runs managed mode via
//      `@qvac/ai-sdk-provider` (OpenCode's own runtime is its compiled binary,
//      which managed mode cannot spawn its supervisor from);
//   2. waits only for the host's proxy to start listening — not for the model
//      to download — and receives the proxy's base URL and access token over a
//      dedicated handshake pipe;
//   3. registers an authenticated OpenAI-compatible `qvac` provider pointed at
//      the host proxy and sets it as this project's default model.
//
// The managed serve's own key never leaves the host: the proxy authenticates
// OpenCode with the handshake token and swaps in the real key upstream.
//
// Options come from (lowest to highest precedence) defaults, a `qvac.json` in
// the project dir, the plugin entry's `options`, and `QVAC_*` env.
import type { ChildProcess } from 'node:child_process'

import { Plugin } from '@opencode/plugin'

import { createManagedProviderConfig, PROVIDER_ID } from './managed-serve-handshake.js'
import { resolveOptions, type RawOptions } from './options.js'
import { spawnManagedServeHost } from './spawn-host.js'

// The handshake lands as soon as the proxy listens, so the host can still fail
// afterwards — an incompatible provider, a serve that never becomes healthy.
// Without this the `qvac` provider would just start refusing connections with
// nothing tying that back to the host's own error.
function watchHostExit(child: ChildProcess): void {
  child.once('exit', (code, signal) => {
    if (code === 0 || signal === 'SIGTERM') return
    process.stderr.write(
      `[qvac] managed serve host exited (${code ?? signal ?? 'unknown'}); the qvac provider is no longer available. ` +
        'Restart opencode after resolving the error above.\n'
    )
  })
}

export const QvacManagedServe = Plugin.define({
  id: 'qvac',
  async setup(ctx) {
    const projectDir = ctx.location.directory
    const resolved = resolveOptions({
      pluginOptions: ctx.options as RawOptions,
      projectDir,
      env: process.env
    })

    const { child, listening } = await spawnManagedServeHost({ options: resolved, projectDir })
    watchHostExit(child)

    // Kill the host if registration fails, or it outlives a plugin that never loaded.
    try {
      const provider = createManagedProviderConfig(listening, resolved)
      await ctx.provider.transform((editor) => {
        editor.add(provider)
      })
      // Scoped to the project that lists the plugin, so it never leaks into others.
      if (resolved.setDefaultModel) {
        await ctx.model.transform((editor) => {
          editor.default.set(PROVIDER_ID, listening.modelId)
        })
      }
    } catch (err) {
      child.kill('SIGTERM')
      throw err
    }

    return () => {
      child.kill('SIGTERM')
    }
  }
})

export default QvacManagedServe
