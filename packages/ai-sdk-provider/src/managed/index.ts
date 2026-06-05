import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

import { DEFAULT_API_KEY, DEFAULT_HEADERS } from '../defaults.js'
import type { ManagedQvacProvider, QvacManagedOptions } from '../types.js'
import { modelNames, writeEphemeralConfig } from './config-synthesizer.js'
import { startServeSupervisor } from './supervisor.js'
import type { ServeSupervisor } from './supervisor.js'

// Entry point for managed mode. Synthesizes an ephemeral config from the
// requested model aliases, spawns + health-checks `qvac serve`, then returns a
// branded provider whose `close()` tears the whole thing down.
export async function startManagedQvac (options: QvacManagedOptions): Promise<ManagedQvacProvider> {
  const ephemeral = await writeEphemeralConfig(options.models)

  let supervisor: ServeSupervisor
  try {
    supervisor = await startServeSupervisor({
      models: modelNames(options.models),
      configPath: ephemeral.configPath,
      cleanupConfig: ephemeral.cleanup,
      ...(options.servePort !== undefined ? { port: options.servePort } : {}),
      ...(options.serveHost !== undefined ? { host: options.serveHost } : {}),
      ...(options.serveStartTimeout !== undefined ? { startTimeoutMs: options.serveStartTimeout } : {}),
      ...(options.serveBinPath !== undefined ? { serveBinPath: options.serveBinPath } : {}),
      ...(options.fetch !== undefined ? { fetchImpl: options.fetch } : {})
    })
  } catch (err) {
    // The supervisor cleans up on its own failure path; this is belt-and-braces
    // for errors thrown before the supervisor took ownership of cleanup.
    await ephemeral.cleanup().catch(() => {})
    throw err
  }

  const headers = { ...DEFAULT_HEADERS, ...options.headers }
  const init: Parameters<typeof createOpenAICompatible>[0] = {
    name: 'qvac',
    baseURL: supervisor.baseURL,
    apiKey: options.apiKey ?? DEFAULT_API_KEY,
    headers
  }
  if (options.fetch !== undefined) init.fetch = options.fetch

  const base = createOpenAICompatible(init)

  async function close (): Promise<void> {
    await supervisor.stop()
  }

  const managed = Object.assign(base, {
    baseURL: supervisor.baseURL,
    port: supervisor.port,
    pid: supervisor.pid,
    close,
    [Symbol.asyncDispose]: close
  })

  return managed as unknown as ManagedQvacProvider
}
