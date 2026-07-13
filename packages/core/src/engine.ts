// Worker-facing engine surface. A Bare host (the `@qvac/sdk` worker) drives the
// engine through these: it deserializes a wire request, calls `send`/`stream`/
// `duplex`, and serializes the reply. Config and runtime context arrive out of
// band (the client pushes them) and are injected via `setConfig`/
// `setRuntimeContext`; `initialize`/`cleanupForTerminate`/`close` bracket the
// process lifecycle. This is pure engine — no wire framing lives here.
//
// Bare consumers use the public API in `index.ts` instead; this subpath is for
// a host that owns its own transport.

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
