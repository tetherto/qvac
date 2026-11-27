import { loggingStream, SDK_LOG_ID } from '@qvac/sdk'
import type { Logger } from '@/logger'

type SdkLogSource = typeof loggingStream

export interface SdkWarnings {
  /** Opens the SDK log stream unless one is open. Call before each SDK request
   * whose warnings should reach the serve log; a stream ends with its worker. */
  ensure(): void
  stop(): void
}

export function createSdkWarnings(
  logger: Logger,
  source: SdkLogSource = loggingStream
): SdkWarnings {
  let controller: AbortController | null = null

  return {
    ensure() {
      if (controller) return
      const current = new AbortController()
      controller = current
      void (async () => {
        try {
          for await (const log of source({ id: SDK_LOG_ID }, { signal: current.signal })) {
            if (log.level === 'error') logger.error(log.message)
            else if (log.level === 'warn') logger.warn(log.message)
          }
        } catch (error) {
          if (!current.signal.aborted) {
            const message = error instanceof Error ? error.message : String(error)
            logger.debug(`SDK log stream ended: ${message}`)
          }
        } finally {
          if (controller === current) controller = null
        }
      })()
    },
    stop() {
      controller?.abort()
      controller = null
    }
  }
}
