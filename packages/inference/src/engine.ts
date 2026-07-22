// The engine surface for a host that owns its own transport: it deserializes a
// request, calls `send`/`stream`/`duplex`, and serializes the reply. Config and
// runtime context are injected via `setConfig`/`setRuntimeContext`;
// `initialize`/`cleanupForTerminate`/`close` bracket the process lifecycle. This is
// pure engine — no wire framing lives here.
//
// Bare consumers use the public API in `index.ts` instead.

import type { Request } from './schemas/index.ts'
import { registry } from './registry.ts'
import { handlerSupportsProgress } from './selection.ts'

export {
  send,
  stream,
  duplex,
  close,
  type DuplexSession,
  type DuplexWritable,
  type DuplexReadable
} from './dispatch.ts'
export { setConfig, setRuntimeContext } from './runtime/state.ts'
export { initialize, cleanupForTerminate } from './runtime/lifecycle.ts'

// The wire transport a request needs: reply, stream, progress, or duplex.
// Returns undefined for an unknown type. A host reads it to pick the matching
// response before calling `send`/`stream`/`duplex`. It is request-aware: a reply
// operation that supports progress reports `progress` when the caller asked for
// progress (`withProgress`). Both `stream` and `progress` run through `stream()`;
// the separate `progress` value tells a host to throttle progress updates, which
// a native data stream such as completion tokens must never do.
export function dispatchTransport(request: Request) {
  const entry = registry[request.type]
  if (!entry) return undefined
  if (entry.type !== 'reply') return entry.type
  return handlerSupportsProgress(entry, request) ? 'progress' : 'reply'
}
