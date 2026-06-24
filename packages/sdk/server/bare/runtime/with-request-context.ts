import type { Logger, LogTransport } from "@/logging/types";
import type { LogLevel } from "@qvac/logging";

export interface RequestLogContext {
  requestId: string;
  kind: string;
  modelId: string | undefined;
}

type LogMethod = "error" | "warn" | "info" | "debug" | "trace";

/**
 * Wraps `logger` so every emit is prefixed with
 * `[request-lifecycle <kind> requestId=<id> modelId=<modelId>] `
 * (the `modelId=...` segment is dropped when absent). The wrapper is a
 * thin shim: `setLevel` / `getLevel` / `addTransport` / `setConsoleOutput`
 * pass through to the underlying logger, and transport callbacks receive
 * the prefixed message.
 *
 * @example
 *   await using ctx = await registry.begin({ requestId, kind: "completion", modelId });
 *   const log = withRequestContext(getServerLogger(), ctx);
 *   log.info("decoding token 7");
 *   // → "[request-lifecycle completion requestId=<id> modelId=<id>] decoding token 7"
 */
export function withRequestContext(
  logger: Logger,
  ctx: RequestLogContext,
): Logger {
  const prefix =
    ctx.modelId !== undefined
      ? `[request-lifecycle ${ctx.kind} requestId=${ctx.requestId} modelId=${ctx.modelId}] `
      : `[request-lifecycle ${ctx.kind} requestId=${ctx.requestId}] `;

  function pick(method: LogMethod): (...args: unknown[]) => void {
    switch (method) {
      case "error":
        return logger.error;
      case "warn":
        return logger.warn;
      case "info":
        return logger.info;
      case "debug":
        return logger.debug;
      case "trace":
        return logger.trace;
    }
  }

  function emit(method: LogMethod, args: unknown[]): void {
    const sink = pick(method);
    if (args.length === 0) {
      sink(prefix);
      return;
    }
    const [first, ...rest] = args;
    sink(prefix + String(first), ...rest);
  }

  return {
    error: (...args: unknown[]) => emit("error", args),
    warn: (...args: unknown[]) => emit("warn", args),
    info: (...args: unknown[]) => emit("info", args),
    debug: (...args: unknown[]) => emit("debug", args),
    trace: (...args: unknown[]) => emit("trace", args),
    setLevel: (level: LogLevel) => logger.setLevel(level),
    getLevel: () => logger.getLevel(),
    addTransport: (transport: LogTransport) => logger.addTransport(transport),
    setConsoleOutput: (enabled: boolean) =>
      logger.setConsoleOutput(enabled),
  };
}
