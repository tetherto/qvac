import type { Request } from "@/schemas";
import type { HandlerEntry } from "@/server/rpc/handler-utils";

export interface HandlerSelection {
  handler: HandlerEntry["handler"];
  isDelegated: boolean;
}

export function selectHandler(
  entry: HandlerEntry,
  request: Request,
): HandlerSelection {
  const isDelegated = !!(
    entry.delegatedHandler && entry.isDelegated?.(request)
  );

  return {
    handler: isDelegated ? entry.delegatedHandler! : entry.handler,
    isDelegated,
  };
}

export function handlerSupportsProgress(
  entry: HandlerEntry,
  request: Request,
): boolean {
  return !!(
    "withProgress" in request &&
    request.withProgress &&
    (typeof entry.supportsProgress === "function"
      ? entry.supportsProgress(request)
      : entry.supportsProgress)
  );
}
