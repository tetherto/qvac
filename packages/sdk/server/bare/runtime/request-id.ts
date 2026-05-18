import { randomUUID } from "bare-crypto";

/**
 * Server-side fallback for `requestId`. The new wire contract is that
 * the client generates the id (UUIDv4) at call time so it's surfaced
 * synchronously on the `CompletionRun` for use with `cancel({ requestId })`.
 * To keep older clients working, the request schema marks `requestId`
 * optional and the server fills it in here when it's missing.
 *
 * `bare-crypto.randomUUID()` mirrors Node's `crypto.randomUUID()` and is
 * Bare-runtime safe. Returns a v4 UUID.
 */
export function generateServerRequestId(): string {
  return randomUUID();
}
