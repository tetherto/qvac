import { nowMs } from "./clock";
import { record } from "./controller";
import type { ProfilingEventKind } from "./types";
import type { ServerBreakdown, DelegationBreakdown } from "@/schemas";

export interface BaseTimings {
  profileId: string;
  requestType: string;
  requestStart: number;
}

export interface BaseEvent {
  ts: number;
  op: string;
  kind: ProfilingEventKind;
  profileId: string;
}

export function recordPhase(
  base: BaseEvent,
  phase: string,
  ms?: number,
  extra?: { count?: number },
): void {
  if (ms === undefined) return;
  record({ ...base, phase, ms, ...extra });
}

export function recordFailure(
  base: BaseEvent,
  startTime: number,
  error: unknown,
): void {
  const now = nowMs();
  record({
    ...base,
    ts: now,
    phase: "failed",
    ms: now - startTime,
    tags: {
      error: error instanceof Error ? error.name : "Unknown",
      message:
        error instanceof Error
          ? error.message.slice(0, 100)
          : String(error).slice(0, 100),
    },
  });
}

export function recordServerBreakdownPhases(
  base: BaseEvent,
  server: ServerBreakdown,
  prefix: string = "server",
): void {
  recordPhase(base, `${prefix}.request.jsonParse`, server.requestJsonParseMs);
  recordPhase(
    base,
    `${prefix}.request.zodValidation`,
    server.requestZodValidationMs,
  );
  recordPhase(base, `${prefix}.handlerExecution`, server.handlerExecutionMs);
  recordPhase(
    base,
    `${prefix}.response.zodValidation`,
    server.responseZodValidationMs,
  );
  recordPhase(base, `${prefix}.response.stringify`, server.responseStringifyMs);
  recordPhase(base, `${prefix}.totalServerTime`, server.totalServerMs);
}

export function recordDelegationBreakdownPhases(
  base: BaseEvent,
  delegation: DelegationBreakdown,
  prefix: string = "delegation",
): void {
  recordPhase(base, `${prefix}.connection`, delegation.connectionMs);
  recordPhase(
    base,
    `${prefix}.request.stringify`,
    delegation.requestStringifyMs,
  );
  recordPhase(base, `${prefix}.serverWait`, delegation.serverWaitMs);
  recordPhase(
    base,
    `${prefix}.response.jsonParse`,
    delegation.responseJsonParseMs,
  );
  recordPhase(
    base,
    `${prefix}.totalDelegationTime`,
    delegation.totalDelegationMs,
  );
}
