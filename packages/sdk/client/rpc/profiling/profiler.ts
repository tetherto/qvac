import {
  nowMs,
  record,
  recordPhase,
  recordServerBreakdownPhases,
  recordDelegationBreakdownPhases,
  type BaseTimings,
  type BaseEvent,
} from "@/profiling";
import type { ProfilingResponseMeta } from "@/schemas";
import { getGlobalSingleton } from "@/utils/global-singleton";

interface ConnectionTrackingState {
  connectionTimeRecorded: boolean;
  pendingConnectionTimeMs: number | undefined;
}

const CONNECTION_TRACKING_STATE_KEY = Symbol.for(
  "@qvac/sdk:rpc-connection-tracking-state",
);

function getConnectionTrackingState(): ConnectionTrackingState {
  return getGlobalSingleton(CONNECTION_TRACKING_STATE_KEY, () => {
    return {
      connectionTimeRecorded: false,
      pendingConnectionTimeMs: undefined,
    };
  });
}

interface BaseClientTimings extends BaseTimings {
  requestZodValidationMs?: number;
  requestStringifyMs?: number;
  sendStart?: number;
  requestEnd?: number;
}

export interface ClientTimings extends BaseClientTimings {
  firstResponseAt?: number;
  responseJsonParseMs?: number;
  responseZodValidationMs?: number;
}

export interface ClientStreamTimings extends BaseClientTimings {
  firstChunkAt?: number;
  lastChunkAt?: number;
  chunkCount: number;
}

function recordRequestPhases(
  base: BaseEvent,
  timings: BaseClientTimings,
): void {
  recordPhase(base, "request.zodValidation", timings.requestZodValidationMs);
  recordPhase(base, "request.stringify", timings.requestStringifyMs);
  if (
    timings.requestZodValidationMs !== undefined &&
    timings.requestStringifyMs !== undefined
  ) {
    recordPhase(
      base,
      "request.totalSerialization",
      timings.requestZodValidationMs + timings.requestStringifyMs,
    );
  }
}

function createBaseTimings(
  profileId: string,
  requestType: string,
): BaseClientTimings {
  return { profileId, requestType, requestStart: nowMs() };
}

export function createClientTimings(
  profileId: string,
  requestType: string,
): ClientTimings {
  return createBaseTimings(profileId, requestType);
}

export function createClientStreamTimings(
  profileId: string,
  requestType: string,
): ClientStreamTimings {
  return { ...createBaseTimings(profileId, requestType), chunkCount: 0 };
}

export function cacheConnectionTime(durationMs: number): void {
  const state = getConnectionTrackingState();
  if (state.connectionTimeRecorded) return;
  if (state.pendingConnectionTimeMs !== undefined) return;
  state.pendingConnectionTimeMs = durationMs;
}

export function flushConnectionTime(): void {
  const state = getConnectionTrackingState();
  if (state.connectionTimeRecorded) return;
  if (state.pendingConnectionTimeMs === undefined) return;

  const durationMs = state.pendingConnectionTimeMs;
  state.pendingConnectionTimeMs = undefined;
  state.connectionTimeRecorded = true;
  record({
    ts: nowMs(),
    op: "rpc",
    kind: "rpc",
    phase: "connection",
    ms: durationMs,
  });
}

export function recordClientEvents(
  timings: ClientTimings,
  serverMeta?: ProfilingResponseMeta,
): void {
  const now = nowMs();
  const totalClientTime = now - timings.requestStart;
  const base: BaseEvent = {
    ts: now,
    op: timings.requestType,
    kind: "rpc",
    profileId: timings.profileId,
  };

  recordRequestPhases(base, timings);

  // For unary requests, this measures send → full response received
  if (
    timings.sendStart !== undefined &&
    timings.firstResponseAt !== undefined
  ) {
    recordPhase(
      base,
      "serverWait",
      timings.firstResponseAt - timings.sendStart,
    );
  }

  recordPhase(base, "response.jsonParse", timings.responseJsonParseMs);
  recordPhase(base, "response.zodValidation", timings.responseZodValidationMs);
  if (
    timings.responseJsonParseMs !== undefined &&
    timings.responseZodValidationMs !== undefined
  ) {
    recordPhase(
      base,
      "response.totalParsing",
      timings.responseJsonParseMs + timings.responseZodValidationMs,
    );
  }

  recordPhase(base, "totalClientTime", totalClientTime);

  if (serverMeta?.server) {
    recordServerBreakdownPhases(base, serverMeta.server, "server");
    if (serverMeta.server.totalServerMs !== undefined) {
      recordPhase(
        base,
        "clientOverhead",
        totalClientTime - serverMeta.server.totalServerMs,
      );
    }
  }

  if (serverMeta?.delegation) {
    recordDelegationBreakdownPhases(base, serverMeta.delegation);
  }
}

export function recordClientStreamEvents(
  timings: ClientStreamTimings,
  serverMeta?: ProfilingResponseMeta,
): void {
  const now = nowMs();
  const totalClientTime = now - timings.requestStart;
  const base: BaseEvent = {
    ts: now,
    op: timings.requestType,
    kind: "rpc",
    profileId: timings.profileId,
  };

  recordRequestPhases(base, timings);

  if (timings.sendStart !== undefined && timings.firstChunkAt !== undefined) {
    recordPhase(base, "ttfb", timings.firstChunkAt - timings.sendStart);
  }
  if (timings.firstChunkAt !== undefined && timings.lastChunkAt !== undefined) {
    recordPhase(
      base,
      "streamDuration",
      timings.lastChunkAt - timings.firstChunkAt,
    );
  }

  recordPhase(base, "totalClientTime", totalClientTime, {
    count: timings.chunkCount,
  });

  if (serverMeta?.server) {
    recordServerBreakdownPhases(base, serverMeta.server, "server");
  }

  if (serverMeta?.delegation) {
    recordDelegationBreakdownPhases(base, serverMeta.delegation);
  }
}

export function resetConnectionTracking(): void {
  const state = getConnectionTrackingState();
  state.connectionTimeRecorded = false;
  state.pendingConnectionTimeMs = undefined;
}
