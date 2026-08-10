import type { HostLogger } from './host-logger.js'
import type { ManagedServeHostConfig } from './managed-serve-config.js'
import { generateProxyToken, type HostListening } from './managed-serve-handshake.js'
import { originOf, startOpenAICompatibleProxy, type Upstream } from './openai-compatible-proxy.js'

// The subset of `ManagedQvacProvider` the host needs. `apiKey` and `baseURL` are
// live getters on the real provider, so they are read per request rather than
// snapshotted.
export interface ManagedServeHandle {
  readonly apiKey: string
  readonly baseURL: string
  readonly port: number
  readonly pid: number
  close: () => Promise<void>
}

export interface HostRuntimeDeps {
  readonly config: ManagedServeHostConfig
  readonly logger: HostLogger
  readonly emitHandshake: (listening: HostListening) => void
  readonly startManagedServe: () => Promise<ManagedServeHandle>
}

export interface RunningManagedServeHost {
  // Resolves when managed serve is healthy; rejects with its startup failure.
  readonly whenManaged: Promise<void>
  stop: (reason: string) => Promise<void>
}

interface Deferred {
  readonly promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Bring the authenticated proxy up first and hand OpenCode its credentials as
// soon as it listens, so a cold model download stays first-request work instead
// of plugin-startup work. Requests that arrive early queue on `upstreamReady`.
export async function startManagedServeHost(
  deps: HostRuntimeDeps
): Promise<RunningManagedServeHost> {
  const { config, logger } = deps
  const t0 = Date.now()
  const proxyToken = generateProxyToken()
  const live: { managed: ManagedServeHandle | undefined } = { managed: undefined }
  const upstreamReady = deferred()

  function currentUpstream(): Upstream | undefined {
    if (live.managed === undefined) return undefined
    try {
      return originOf(live.managed.baseURL)
    } catch {
      return undefined
    }
  }

  const proxy = await startOpenAICompatibleProxy({
    proxyToken,
    getUpstream: currentUpstream,
    getApiKey: () => live.managed?.apiKey,
    whenUpstream: upstreamReady.promise,
    openAICompatTransforms: config.openAICompatTransforms,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    logger
  })
  const proxyBaseURL = `http://127.0.0.1:${proxy.port}/v1`

  deps.emitHandshake({
    proxyToken,
    baseURL: proxyBaseURL,
    modelId: config.modelId,
    modelName: config.modelName
  })

  logger.log(
    `starting managed serve for ${config.modelId} (ctx_size=${config.ctxSize}, reasoning_budget=${config.reasoningBudget}, tools=${config.tools})...`
  )
  logger.log('first run downloads the model - this can take a while.')

  const whenManaged = (async () => {
    const managed = await deps.startManagedServe()
    live.managed = managed
    upstreamReady.resolve()
    logger.log(`healthy in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    logger.log(
      `QVAC_READY ${JSON.stringify({ baseURL: proxyBaseURL, servePort: managed.port, pid: managed.pid, modelId: config.modelId })}`
    )
  })()

  let stopping = false
  async function stop(reason: string): Promise<void> {
    if (stopping) return
    stopping = true
    logger.trace(`shutting down: ${reason}`)
    await live.managed?.close().catch(() => {})
    await proxy.close().catch(() => {})
  }

  return { whenManaged, stop }
}
