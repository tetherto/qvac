import type { Request } from "@/schemas";
import type { HandlerEntry } from "./handler-utils";

export function shouldUseStreamErrorTransport(
  entry: HandlerEntry | undefined,
  rawRequest: Record<string, unknown> | undefined,
): boolean {
  if (!entry) return false;
  if (entry.type === "stream") return true;
  if (entry.type !== "reply") return false;
  if (rawRequest?.["withProgress"] !== true) return false;

  try {
    return typeof entry.supportsProgress === "function"
      ? entry.supportsProgress(rawRequest as Request)
      : !!entry.supportsProgress;
  } catch {
    return !!entry.supportsProgress;
  }
}
