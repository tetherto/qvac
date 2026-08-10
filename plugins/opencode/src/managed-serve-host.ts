import { createQvac } from '@qvac/ai-sdk-provider'

import { startManagedServeHost, type PossiblyIncompatibleHandle } from './host-runtime.js'
import { createHostLogger, formatUnknownError } from './host-logger.js'
import {
  resolveManagedServeHostConfig,
  type ManagedServeHostConfig
} from './managed-serve-config.js'
import { writeHostListening } from './managed-serve-handshake.js'

function createManagedServe(config: ManagedServeHostConfig): Promise<PossiblyIncompatibleHandle> {
  return createQvac({
    mode: 'managed',
    reuse: true,
    closeOnParentExit: true,
    models: [
      {
        name: config.modelId,
        config: {
          ctx_size: config.ctxSize,
          reasoning_budget: config.reasoningBudget,
          tools: config.tools,
          toolsMode: 'static'
        },
        default: true
      }
    ],
    serveStartTimeout: config.readyTimeoutMs
  })
}

async function main(): Promise<void> {
  const config = resolveManagedServeHostConfig(process.env)
  const logger = createHostLogger({ debug: config.debug, logFile: config.logFile })

  const host = await startManagedServeHost({
    config,
    logger,
    emitHandshake: writeHostListening,
    startManagedServe: () => createManagedServe(config)
  })

  async function stop(reason: string): Promise<void> {
    await host.stop(reason)
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  await host.whenManaged
  await new Promise<void>(() => {})
}

void main().catch((err: unknown) => {
  const logger = createHostLogger({ debug: true, logFile: process.env['QVAC_HOST_LOG'] })
  logger.error(`qvac managed serve host failed: ${formatUnknownError(err)}`)
  process.exit(1)
})
