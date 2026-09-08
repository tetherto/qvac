import type { ServerResponse } from 'node:http'
import { cancel } from '@qvac/sdk'
import type { Logger } from '@/logger'

interface CancelBinding {
  requestIds: Set<string>
  cancelFn: (opts: { requestId: string }) => Promise<void>
  clientGone: boolean
}

const bindings = new WeakMap<ServerResponse, CancelBinding>()

/**
 * Bind the HTTP request lifecycle to an SDK `requestId` so a client
 * disconnect (browser tab closed, `fetch().abort()`, network drop)
 * cancels the underlying SDK call promptly.
 *
 * The bridge listens for the `close` event on the response stream. Fastify
 * consumes the request body before a route handler runs, so by the time this
 * binds, `req` has already emitted `close` and a listener added then never
 * fires.
 *
 *  - If the response has already finished (`res.writableEnded`), the
 *    request completed naturally and we skip the cancel — firing one
 *    would log a spurious "no in-flight request matched" line on the
 *    worker without doing anything useful.
 *  - Otherwise the client disappeared mid-stream and we issue a
 *    targeted `cancel({ requestId })` so the SDK handler stops
 *    yielding tokens / running inference / fetching bytes.
 *
 * Fire-and-forget by design. `res.on('close')` is synchronous and
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
 *
 * A route may bind several ids for one request. One `close` listener serves a
 * response however many ids it carries, and cancels all of them. `close` fires
 * once and is not replayed, so an id bound after it is cancelled on the spot
 * instead.
 *
 * Optional `cancelFn` override is for unit tests only — production callers
 * omit it and the bridge uses the SDK's `cancel` directly. The override
 * exists because ESM named imports cannot be cleanly substituted at test
 * time without `--experimental-test-module-mocks`; threading an injection
 * point through keeps the test fast and free of module-mock plumbing.
 */
export function bindClientDisconnectCancel(
  res: ServerResponse,
  requestId: string,
  logger: Logger,
  cancelFn: (opts: { requestId: string }) => Promise<void> = cancel
): void {
  const bound = bindings.get(res)
  if (bound) {
    if (bound.clientGone) {
      fireCancel(bound, requestId, logger)
      return
    }
    bound.requestIds.add(requestId)
    return
  }

  const binding: CancelBinding = { requestIds: new Set([requestId]), cancelFn, clientGone: false }
  bindings.set(res, binding)

  res.once('close', () => {
    if (res.writableEnded) {
      bindings.delete(res)
      return
    }
    binding.clientGone = true
    for (const id of binding.requestIds) fireCancel(binding, id, logger)
  })
}

function fireCancel(binding: CancelBinding, requestId: string, logger: Logger): void {
  binding.cancelFn({ requestId }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    logger.debug(`  cancel-on-disconnect failed for requestId=${requestId}: ${message}`)
  })
}
