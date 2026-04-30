import {
  nowMs,
  record,
  shouldProfile,
  recordPhase,
  recordServerBreakdownPhases,
  type BaseTimings,
  type BaseEvent,
} from "@/profiling";
import type {
  ProfilingRequestMeta,
  ProfilingResponseMeta,
  DelegationBreakdown,
} from "@/schemas";

export interface DelegatedHandlerOptions {
  profilingMeta?: ProfilingRequestMeta;
}

/**
 * Per-peer connection tracking for delegation.
 * Separate tracking for server-side event recording vs breakdown injection.
 *
 * Flow:
 * 1. Connection happens → cacheDelegationConnectionTime stores ms
 * 2. First profiled call (stream or unary) → flushServerConnectionEvent records server event
 * 3. First unary call → consumeBreakdownConnectionTime returns ms for breakdown injection
 */
const pendingConnectionTimes = new Map<string, number>();
const serverConnectionRecorded = new Map<string, boolean>();
const breakdownConnectionMs = new Map<string, number>();
const breakdownConnectionInjected = new Map<string, boolean>();

interface BaseDelegationTimings extends BaseTimings {
  requestStringifyMs?: number;
  sendStart?: number;
}

export interface DelegationTimings extends BaseDelegationTimings {
  firstResponseAt?: number;
  responseJsonParseMs?: number;
}

export interface DelegationStreamTimings extends BaseDelegationTimings {
  firstChunkAt?: number;
  lastChunkAt?: number;
  chunkCount: number;
}

export function shouldProfileDelegation(
  op: string,
  incomingMeta?: ProfilingRequestMeta,
): boolean {
  if (incomingMeta?.enabled === false) {
    return false;
  }
  if (incomingMeta?.enabled === true) {
    return true;
  }
  return shouldProfile(op);
}

export function createDelegationTimings(
  profileId: string,
  requestType: string,
): DelegationTimings {
  return { profileId, requestType, requestStart: nowMs() };
}

export function createDelegationStreamTimings(
  profileId: string,
  requestType: string,
): DelegationStreamTimings {
  return { profileId, requestType, requestStart: nowMs(), chunkCount: 0 };
}

export function cacheDelegationConnectionTime(
  peerKey: string,
  durationMs: number,
): void {
  if (serverConnectionRecorded.get(peerKey)) return;
  if (pendingConnectionTimes.has(peerKey)) return;
  pendingConnectionTimes.set(peerKey, durationMs);
}

export function flushServerConnectionEvent(peerKey: string): void {
  if (serverConnectionRecorded.get(peerKey)) return;

  const ms = pendingConnectionTimes.get(peerKey);
  if (ms === undefined) return;

  pendingConnectionTimes.delete(peerKey);
  serverConnectionRecorded.set(peerKey, true);

  if (!breakdownConnectionInjected.get(peerKey)) {
    breakdownConnectionMs.set(peerKey, ms);
  }

  record({
    ts: nowMs(),
    op: "delegation",
    kind: "delegation",
    phase: "connection",
    ms,
    tags: { peer: peerKey.slice(0, 16) },
  });
}

export function consumeBreakdownConnectionTime(
  peerKey: string,
): number | undefined {
  if (breakdownConnectionInjected.get(peerKey)) return undefined;

  const ms = breakdownConnectionMs.get(peerKey);
  if (ms === undefined) return undefined;

  breakdownConnectionMs.delete(peerKey);
  breakdownConnectionInjected.set(peerKey, true);

  return ms;
}

export function buildDelegationBreakdown(
  timings: DelegationTimings,
  connectionMs?: number,
): DelegationBreakdown {
  const now = nowMs();
  const breakdown: DelegationBreakdown = {
    profileId: timings.profileId,
  };

  if (connectionMs !== undefined) {
    breakdown.connectionMs = connectionMs;
  }
  if (timings.requestStringifyMs !== undefined) {
    breakdown.requestStringifyMs = timings.requestStringifyMs;
  }
  if (
    timings.sendStart !== undefined &&
    timings.firstResponseAt !== undefined
  ) {
    breakdown.serverWaitMs = timings.firstResponseAt - timings.sendStart;
  }
  if (timings.responseJsonParseMs !== undefined) {
    breakdown.responseJsonParseMs = timings.responseJsonParseMs;
  }
  breakdown.totalDelegationMs = now - timings.requestStart;

  return breakdown;
}

export function buildDelegationStreamBreakdown(
  timings: DelegationStreamTimings,
): DelegationBreakdown {
  const now = nowMs();
  const breakdown: DelegationBreakdown = {
    profileId: timings.profileId,
  };

  if (timings.requestStringifyMs !== undefined) {
    breakdown.requestStringifyMs = timings.requestStringifyMs;
  }
  if (timings.sendStart !== undefined && timings.firstChunkAt !== undefined) {
    breakdown.serverWaitMs = timings.firstChunkAt - timings.sendStart;
  }
  breakdown.totalDelegationMs = now - timings.requestStart;

  return breakdown;
}

export function recordDelegationEvents(
  timings: DelegationTimings,
  serverMeta?: ProfilingResponseMeta,
  connectionMs?: number,
): DelegationBreakdown {
  const now = nowMs();
  const base: BaseEvent = {
    ts: now,
    op: timings.requestType,
    kind: "delegation",
    profileId: timings.profileId,
  };

  const breakdown = buildDelegationBreakdown(timings, connectionMs);

  recordPhase(base, "request.stringify", breakdown.requestStringifyMs);
  recordPhase(base, "serverWait", breakdown.serverWaitMs);
  recordPhase(base, "response.jsonParse", breakdown.responseJsonParseMs);
  recordPhase(base, "totalDelegationTime", breakdown.totalDelegationMs);

  if (serverMeta?.server) {
    recordServerBreakdownPhases(base, serverMeta.server, "delegated");
  }

  return breakdown;
}

export function recordDelegationStreamEvents(
  timings: DelegationStreamTimings,
  serverMeta?: ProfilingResponseMeta,
): void {
  const now = nowMs();
  const totalTime = now - timings.requestStart;
  const base: BaseEvent = {
    ts: now,
    op: timings.requestType,
    kind: "delegation",
    profileId: timings.profileId,
  };

  recordPhase(base, "request.stringify", timings.requestStringifyMs);

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

  recordPhase(base, "totalDelegationTime", totalTime, {
    count: timings.chunkCount,
  });

  if (serverMeta?.server) {
    recordServerBreakdownPhases(base, serverMeta.server, "delegated");
  }
}

export function clearPeerConnectionTracking(peerKey: string): void {
  pendingConnectionTimes.delete(peerKey);
  serverConnectionRecorded.delete(peerKey);
  breakdownConnectionMs.delete(peerKey);
  breakdownConnectionInjected.delete(peerKey);
}

export function resetDelegationConnectionTracking(): void {
  pendingConnectionTimes.clear();
  serverConnectionRecorded.clear();
  breakdownConnectionMs.clear();
  breakdownConnectionInjected.clear();
}
