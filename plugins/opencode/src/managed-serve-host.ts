import { createQvac } from '@qvac/ai-sdk-provider'

import { createHostLogger, formatUnknownError } from './host-logger.js'
import { resolveManagedServeHostConfig } from './managed-serve-config.js'
import { originOf, startOpenAICompatibleProxy, type Upstream } from './openai-compatible-proxy.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T> (): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function main (): Promise<void> {
  const config = resolveManagedServeHostConfig(process.env)
  const logger = createHostLogger({ debug: config.debug, logFile: config.logFile })
  const t0 = Date.now()
  const live: { upstream: Upstream | undefined } = { upstream: undefined }
  const upstreamReady = deferred<void>()

  const proxy = await startOpenAICompatibleProxy({
    getUpstream: () => live.upstream,
    whenUpstream: upstreamReady.promise,
    openAICompatTransforms: config.openAICompatTransforms,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    logger
  })
  const proxyBaseURL = `http://127.0.0.1:${proxy.port}/v1`
  logger.log(`QVAC_LISTENING ${JSON.stringify({ baseURL: proxyBaseURL, modelId: config.modelId, modelName: config.modelName })}`)

  logger.log(`starting managed serve for ${config.modelId} (ctx_size=${config.ctxSize}, reasoning_budget=${config.reasoningBudget}, tools=${config.tools})...`)
  logger.log('first run downloads the model - this can take a while.')

  const qvac = await createQvac({
    mode: 'managed',
    reuse: true,
    closeOnParentExit: true,
    models: [
      {
        name: config.modelId,
        config: { ctx_size: config.ctxSize, reasoning_budget: config.reasoningBudget, tools: config.tools },
        default: true
      }
    ],
    serveStartTimeout: config.readyTimeoutMs
  })

  live.upstream = originOf(qvac.baseURL)
  upstreamReady.resolve()
  logger.log(`healthy in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  logger.log(`QVAC_READY ${JSON.stringify({ baseURL: proxyBaseURL, servePort: qvac.port, pid: qvac.pid, modelId: config.modelId })}`)

  let stopping = false
  async function stop (reason: string): Promise<void> {
    if (stopping) return
    stopping = true
    logger.trace(`shutting down: ${reason}`)
    await qvac.close().catch(() => {})
    await proxy.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  const retarget = setInterval(() => {
    try {
      live.upstream = originOf(qvac.baseURL)
    } catch {
      // keep the last known origin
    }
  }, 2000)
  retarget.unref()

  await new Promise<void>(() => {})
}

void main().catch((err: unknown) => {
  const logger = createHostLogger({ debug: true, logFile: process.env['QVAC_HOST_LOG'] })
  logger.error(`qvac managed serve host failed: ${formatUnknownError(err)}`)
  process.exit(1)
})
