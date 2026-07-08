import { randomUUID } from 'bare-crypto'

/**
 * Fallback for `requestId`. The contract is that the caller generates
 * the id (UUIDv4) at call time so it's surfaced synchronously on the
 * `CompletionRun` for use with `cancel({ requestId })`. The request
 * schema marks `requestId` optional, and core fills it in here when
 * it's missing.
 *
 * `bare-crypto.randomUUID()` mirrors Node's `crypto.randomUUID()` and is
 * Bare-runtime safe. Returns a v4 UUID.
 */
export function generateServerRequestId(): string {
  return randomUUID()
}
