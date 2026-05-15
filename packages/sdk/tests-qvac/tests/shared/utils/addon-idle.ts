import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

const ADDON_BUSY_TIMEOUT_MS = 30_000;
const ADDON_BUSY_POLL_MS = 250;

// Documented busy throw from infer-llamacpp-llm; we retry until idle.
const ADDON_BUSY_MARKER = "a job is already set or being processed";

export class AddonBusyTimeoutError extends Error {
  constructor(timeoutMs: number, cause: unknown) {
    super(`Addon stayed busy: waited ${timeoutMs}ms`, { cause });
    this.name = "AddonBusyTimeoutError";
  }
}

// Errors cross the RPC boundary as `RPCError`, so match by code, not `instanceof`.
export function isTransientAddonBusy(err: unknown): boolean {
  if (
    err !== null
    && typeof err === "object"
    && "code" in err
    && (err as { code?: unknown }).code === SDK_SERVER_ERROR_CODES.REQUEST_REJECTED_BY_POLICY
  ) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(ADDON_BUSY_MARKER);
}

// Retries `fn` while it rejects with a transient "slot still occupied" error.
export async function callWhenAddonIdle<T>(
  fn: () => Promise<T>,
  timeoutMs = ADDON_BUSY_TIMEOUT_MS,
  intervalMs = ADDON_BUSY_POLL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (isTransientAddonBusy(err)) {
        if (Date.now() >= deadline) throw new AddonBusyTimeoutError(timeoutMs, err);
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
