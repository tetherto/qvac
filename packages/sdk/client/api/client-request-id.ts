/**
 * UUIDv4 generator for client-side request ids. The Web Crypto API
 * ships `crypto.randomUUID` everywhere we run today (Bun, modern Node,
 * modern browsers, React Native via the polyfill that the workbench-
 * desktop / RN runtime config injects). The fallback exists so the SDK
 * never crashes in an exotic JS environment without
 * `crypto.randomUUID` — `requestId` semantics still hold (uniqueness,
 * opaque to the caller), just without the UUIDv4 wire shape.
 *
 * Shared with the long-running call sites that decorate their promises
 * with `requestId`: `completion(...)`, `loadModel(...)`,
 * `downloadAsset(...)`. The decorated promise's `op.requestId` and the
 * server's registry entry's `requestId` must match — generating once
 * here keeps that invariant.
 */
export function generateClientRequestId(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: 128 random bits encoded as a hex string. Distinct enough
  // for in-flight cancel targeting; not a wire-spec UUID.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
