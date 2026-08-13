import {
  HostUnavailableError,
  IncompatibleProviderError,
  UntrustedUpstreamError
} from './errors.js'
import type { HostLogger } from './host-logger.js'
import type { ManagedServeHostConfig } from './managed-serve-config.js'
import { generateProxyToken, type HostListening } from './managed-serve-handshake.js'
import {
  isLoopbackUpstream,
  originOf,
  startOpenAICompatibleProxy,
  type Upstream
} from './openai-compatible-proxy.js'

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

// What the resolved `@qvac/ai-sdk-provider` may actually hand back. `apiKey` is
// deliberately untyped here because an install can predate
// `ManagedQvacProvider.apiKey`; `assertCompatibleHandle` is the single gate that
// narrows this to `ManagedServeHandle`. Requiring the key at compile time would
// only move that failure to whichever machine installed the older provider.
export interface PossiblyIncompatibleHandle {
  readonly apiKey?: unknown
  readonly baseURL: string
  readonly port: number
  readonly pid: number
  close: () => Promise<void>
}

export interface HostRuntimeDeps {
  readonly config: ManagedServeHostConfig
  readonly logger: HostLogger
  readonly emitHandshake: (listening: HostListening) => void
  readonly startManagedServe: () => Promise<PossiblyIncompatibleHandle>
}

export interface RunningManagedServeHost {
  // Resolves when managed serve is healthy; rejects with its startup failure.
  readonly whenManaged: Promise<void>
  stop: (reason: string) => Promise<void>
}

interface Deferred {
  readonly promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  let settled = false
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      if (settled) return
      settled = true
      res()
    }
    reject = (err: unknown) => {
      if (settled) return
      settled = true
      rej(err)
    }
  })
  // Waiters attach lazily, so keep an owner on the rejection path at all times.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

// The runtime gate for a provider that may predate `ManagedQvacProvider.apiKey`.
// Never put the credential itself in the failure.
function assertCompatibleHandle(
  handle: PossiblyIncompatibleHandle
): asserts handle is ManagedServeHandle {
  const apiKey: unknown = handle.apiKey
  if (typeof apiKey !== 'string') {
    throw new IncompatibleProviderError(
      'apiKey',
      `is ${apiKey === undefined ? 'missing' : 'not a string'}`
    )
  }
  if (apiKey.trim().length === 0) {
    throw new IncompatibleProviderError('apiKey', 'is empty')
  }
  let upstream: Upstream
  try {
    upstream = originOf(handle.baseURL)
  } catch {
    throw new IncompatibleProviderError(
      'baseURL',
      `is not a usable URL ("${String(handle.baseURL)}")`
    )
  }
  if (!isLoopbackUpstream(upstream)) {
    throw new UntrustedUpstreamError(upstream.hostname)
  }
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

  // `baseURL` is a live getter: a crash-recovery respawn can move the serve, so
  // re-check the destination on every read rather than trusting the startup one.
  function currentUpstream(): Upstream | undefined {
    if (live.managed === undefined) return undefined
    try {
      const upstream = originOf(live.managed.baseURL)
      return isLoopbackUpstream(upstream) ? upstream : undefined
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
    let managed: PossiblyIncompatibleHandle
    try {
      managed = await deps.startManagedServe()
    } catch (err) {
      upstreamReady.reject(err)
      throw err
    }
    try {
      assertCompatibleHandle(managed)
    } catch (err) {
      await managed.close().catch(() => {})
      upstreamReady.reject(err)
      throw err
    }
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
    // Releases anything still queued on startup before the sockets go away, so a
    // stop mid-download answers those requests. A failed startup rejects the same
    // waiters but exits as that propagates, so those callers usually see a reset.
    upstreamReady.reject(new HostUnavailableError(`host is shutting down (${reason})`))
    await live.managed?.close().catch(() => {})
    await proxy.close().catch(() => {})
  }

  return { whenManaged, stop }
}
