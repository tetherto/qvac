import type RPC from 'bare-rpc'
import { getClientLogger } from '@/logging'

const logger = getClientLogger()

const SHUTDOWN_RPC_TIMEOUT_MS = 10_000

/**
 * Pre-terminate cleanup roundtrip. Sends an internal `__shutdown__` message
 * to the worker so it can clear addon plugin registries (calls each addon's
 * `releaseLogger` → frees env-bound js_ref_t state) and unload all model
 * instances BEFORE the worker is terminated.
 *
 * Without this, the worklet's V8 isolate dies while addon static state still
 * holds js_ref_t handles into it; the next worklet's first `setLogger` call
 * trips a V8 GlobalHandle assertion (brk 0 / SIGTRAP) and the iOS app dies.
 *
 * Best-effort: never throws. Falls through to terminate even on timeout.
 */
export async function sendShutdownMessage(rpc: RPC): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        const req = rpc.request(1)
        req.send(JSON.stringify({ type: '__shutdown__' }), 'utf8')
        const response = await req.reply('utf8')
        const parsed = JSON.parse(String(response)) as {
          success: boolean
          error?: string
        }
        if (!parsed.success) {
          throw new Error(parsed.error ?? 'Worker reported cleanup failure')
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Worker did not ack __shutdown__ within ${SHUTDOWN_RPC_TIMEOUT_MS}ms`)
            ),
          SHUTDOWN_RPC_TIMEOUT_MS
        )
      })
    ])
  } catch (error) {
    // Best-effort: log but don't block termination if cleanup fails.
    logger.warn(
      `⚠️ Pre-terminate worker cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}
