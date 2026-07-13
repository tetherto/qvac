// The engine surface for a host that owns its own transport: it deserializes a
// request, calls `send`/`stream`/`duplex`, and serializes the reply. Config and
// runtime context are injected via `setConfig`/`setRuntimeContext`;
// `initialize`/`cleanupForTerminate`/`close` bracket the process lifecycle. This is
// pure engine — no wire framing lives here.
//
// Bare consumers use the public API in `index.ts` instead.

import { registry } from './registry'

export {
  send,
  stream,
  duplex,
  close,
  type DuplexSession,
  type DuplexWritable,
  type DuplexReadable
} from './dispatch'
export { setConfig, setRuntimeContext } from './runtime/state'
export { initialize, cleanupForTerminate } from './runtime/lifecycle'

// The transport kind for a request type — reply, stream, or duplex; undefined for
// an unknown type. A host reads it to pick the matching wire response before
// calling `send`/`stream`/`duplex`.
export function dispatchKind(type: string) {
  return registry[type]?.type
}
