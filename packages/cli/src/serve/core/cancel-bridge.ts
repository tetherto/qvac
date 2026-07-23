import type { IncomingMessage, ServerResponse } from 'node:http'
import { cancel } from '@qvac/sdk'
import type { Logger } from '../../logger.js'

/**
 * Bind the HTTP request lifecycle to an SDK `requestId` so a client
 * disconnect (browser tab closed, `fetch().abort()`, network drop)
 * cancels the underlying SDK call promptly.
 *
 * The bridge listens for the `close` event on the incoming request:
 *  - If the response has already finished (`res.writableEnded`), the
 *    request completed naturally and we skip the cancel — firing one
 *    would log a spurious "no in-flight request matched" line on the
 *    worker without doing anything useful.
 *  - Otherwise the client disappeared mid-stream and we issue a
 *    targeted `cancel({ requestId })` so the SDK handler stops
 *    yielding tokens / running inference / fetching bytes.
 *
 * Fire-and-forget by design. `req.on('close')` is synchronous and
 * `cancel(...)` runs over RPC; awaiting it inside the listener
 * would block the Node event loop on every disconnect. The `.catch`
 * swallows cancel-after-end races — by the time `close` fires the
 * server may have already settled the request from the other side, in
 * which case the registry walk finds nothing.
 *
 * Per-route binding (not middleware-style on the server) is intentional:
 * the OpenAI routes have different SDK call shapes (`completion` /
 * `embed` / `transcribe`) and surface `requestId` slightly differently.
 * Lifting to middleware buys nothing until a fourth long-running route
 * shows up.
 */
/**
 * Optional `cancelFn` override is for unit tests only — production callers
 * omit it and the bridge uses the SDK's `cancel` directly. The override
 * exists because ESM named imports cannot be cleanly substituted at test
 * time without `--experimental-test-module-mocks`; threading an injection
 * point through keeps the test fast and free of module-mock plumbing.
 */
export function bindClientDisconnectCancel(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  logger: Logger,
  cancelFn: (opts: { requestId: string }) => Promise<void> = cancel
): void {
  const onClose = () => {
    if (res.writableEnded) return
    cancelFn({ requestId }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.debug(`  cancel-on-disconnect failed for requestId=${requestId}: ${message}`)
    })
  }
  req.once('close', onClose)
}
