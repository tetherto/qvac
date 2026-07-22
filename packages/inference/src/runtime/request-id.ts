import { randomUUID } from 'bare-crypto'

/**
 * Mint the `requestId` at call time so it can be surfaced synchronously on the
 * returned handle (e.g. the `CompletionRun`) for use with `cancel({ requestId })`.
 * The decorated promise's `op.requestId` and the request registry entry's
 * `requestId` must be the same value, so it is generated exactly once here.
 *
 * Prefers `crypto.randomUUID` and falls back to 128 random bits as hex when it
 * is unavailable — the fallback keeps `requestId` semantics (unique, opaque)
 * without guaranteeing the UUIDv4 format.
 */
export function generateRequestId(): string {
  const c = (
    globalThis as {
      crypto?: { randomUUID?: () => string }
    }
  ).crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Fill in a missing `requestId` from the runtime's UUID generator. The request
 * schema marks `requestId` optional; this supplies a v4 UUID when the caller
 * did not provide one.
 */
export function generateRandomRequestId(): string {
  return randomUUID()
}
