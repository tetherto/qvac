/**
 * UUIDv4 generator for client-side request and session ids. The Web Crypto
 * API ships `crypto.randomUUID` everywhere we run today (Bun, modern Node,
 * modern browsers, React Native via the polyfill that the workbench-
 * desktop / RN runtime config injects). The fallbacks exist so the SDK
 * never crashes in an exotic JS environment without it: the id stays
 * unique within the process and opaque to the caller, without the UUIDv4
 * wire shape.
 *
 * Shared with the long-running call sites that decorate their promises
 * with `requestId`: `completion(...)`, `loadModel(...)`,
 * `downloadAsset(...)`. The decorated promise's `op.requestId` and the
 * server's registry entry's `requestId` must match — generating once
 * here keeps that invariant.
 */
let fallbackCounter = 0

export function generateClientRequestId(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string
        getRandomValues?: (array: Uint8Array) => Uint8Array
      }
    }
  ).crypto
  if (c?.randomUUID) return c.randomUUID()
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  // No random source at all: a per-process counter keeps ids unique for
  // cancel targeting and session keys, which only have to be unique
  // within this process and its runtime.
  fallbackCounter += 1
  return `${Date.now().toString(16)}-${fallbackCounter.toString(16)}`
}
