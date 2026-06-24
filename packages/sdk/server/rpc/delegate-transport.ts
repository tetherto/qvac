/**
 * Server-side RPC transport for delegated requests.
 *
 * This module provides `send` and `stream` functions for server-side
 * delegation to remote peers (via HyperSwarm RPC).
 */

import type RPC from "bare-rpc";
import {
  requestSchema,
  responseSchema,
  PROFILING_KEY,
  PROFILING_TRAILER_KEY,
  DELEGATION_BREAKDOWN_KEY,
  OPERATION_EVENT_KEY,
  type Request,
  type Response,
  type RPCOptions,
  type ProfilingRequestMeta,
  type ProfilingResponseMeta,
  type DelegationBreakdown,
  type OperationEvent,
} from "@/schemas";
import {
  nowMs,
  extractProfilingMeta,
  stripProfilingMeta,
  recordFailure,
  generateId,
} from "@/profiling";
import { withTimeout, withTimeoutStream } from "@/utils/withTimeout";
import { getServerLogger } from "@/logging";
import { DelegateProviderError } from "@/utils/errors-server";
import { cleanupStaleConnection } from "@/server/bare/delegate-rpc-client";
import {
  shouldProfileDelegation,
  createDelegationTimings,
  createDelegationStreamTimings,
  recordDelegationEvents,
  recordDelegationStreamEvents,
  buildDelegationStreamBreakdown,
  flushServerConnectionEvent,
  consumeBreakdownConnectionTime,
  type DelegationTimings,
  type DelegationStreamTimings,
} from "./profiling/delegation-profiler";
import type { DelegatedHandlerOptions } from "./profiling";

export interface DelegateOptions extends RPCOptions, DelegatedHandlerOptions {
  peerKey?: string;
}

export type ResponseWithDelegation = Response & {
  [DELEGATION_BREAKDOWN_KEY]?: DelegationBreakdown;
  [OPERATION_EVENT_KEY]?: OperationEvent;
};

const logger = getServerLogger();

import { getNextCommandId } from "@/server/rpc/rpc-utils";

function checkAndThrowError(response: Response): void {
  if (response.type === "error") {
    throw new DelegateProviderError(
      response.message || "Unknown provider error",
      response.code,
    );
  }
}

function isConnectionError(error: unknown): boolean {
  return !(error instanceof DelegateProviderError);
}

function cleanupDelegationPeer(options?: DelegateOptions, error?: unknown): void {
  if (!options?.peerKey) return;
  if (error !== undefined && !isConnectionError(error)) return;
  cleanupStaleConnection(options.peerKey);
}

export async function send<T extends Request>(
  request: T,
  rpc: RPC,
  options?: DelegateOptions,
): Promise<Response> {
  const { profilingMeta } = options ?? {};
  const shouldProfile = shouldProfileDelegation(request.type, profilingMeta);

  if (!shouldProfile) {
    return sendBase(request, rpc, options, profilingMeta);
  }
  return sendProfiled(request, rpc, options, profilingMeta);
}

async function sendBase<T extends Request>(
  request: T,
  rpc: RPC,
  options?: DelegateOptions,
  profilingMeta?: ProfilingRequestMeta,
): Promise<Response> {
  try {
    const parsedRequest = requestSchema.parse(request);
    const req = rpc.request(getNextCommandId());

    logger.debug("[delegate-transport] Sending:", { type: request.type });

    // Propagate per-call disable signal to delegated provider
    const finalRequest =
      profilingMeta?.enabled === false
        ? { ...parsedRequest, [PROFILING_KEY]: { enabled: false } }
        : parsedRequest;
    const payload = JSON.stringify(finalRequest);
    req.send(payload, "utf-8");

    const response = await withTimeout(req.reply("utf-8"), options?.timeout);

    const rawPayload = JSON.parse(response?.toString() || "{}") as object;
    const resPayload = responseSchema.parse(stripProfilingMeta(rawPayload));
    logger.debug("[delegate-transport] Response:", { type: resPayload.type });

    checkAndThrowError(resPayload);

    return resPayload;
  } catch (error) {
    cleanupDelegationPeer(options, error);
    throw error;
  }
}

async function sendProfiled<T extends Request>(
  request: T,
  rpc: RPC,
  options?: DelegateOptions,
  profilingMeta?: ProfilingRequestMeta,
): Promise<ResponseWithDelegation> {
  const profileId = profilingMeta?.id ?? generateId();
  const includeServerBreakdown = profilingMeta?.includeServer ?? false;
  const timings: DelegationTimings = createDelegationTimings(
    profileId,
    request.type,
  );

  try {
    if (options?.peerKey) {
      flushServerConnectionEvent(options.peerKey);
    }
    const connectionMs = options?.peerKey
      ? consumeBreakdownConnectionTime(options.peerKey)
      : undefined;

    const parsedRequest = requestSchema.parse(request);
    const req = rpc.request(getNextCommandId());

    logger.debug("[delegate-transport] Sending (profiled):", {
      type: request.type,
    });

    const stringifyStart = nowMs();
    const profilingEnvelope: Record<string, unknown> = { id: profileId };
    if (includeServerBreakdown) {
      profilingEnvelope["includeServer"] = true;
    }
    const requestWithProfiling = {
      ...parsedRequest,
      [PROFILING_KEY]: profilingEnvelope,
    };
    const payload = JSON.stringify(requestWithProfiling);
    timings.requestStringifyMs = nowMs() - stringifyStart;

    timings.sendStart = nowMs();
    req.send(payload, "utf-8");

    const response = await withTimeout(req.reply("utf-8"), options?.timeout);
    timings.firstResponseAt = nowMs();

    const parseStart = nowMs();
    const rawPayload = JSON.parse(response?.toString() || "{}") as object;
    timings.responseJsonParseMs = nowMs() - parseStart;

    const serverMeta = extractProfilingMeta(rawPayload);
    const cleanPayload = stripProfilingMeta(rawPayload);

    const resPayload = responseSchema.parse(
      cleanPayload,
    ) as ResponseWithDelegation;
    logger.debug("[delegate-transport] Response (profiled):", {
      type: resPayload.type,
    });

    checkAndThrowError(resPayload);

    const delegationBreakdown = recordDelegationEvents(
      timings,
      serverMeta,
      connectionMs,
    );
    resPayload[DELEGATION_BREAKDOWN_KEY] = delegationBreakdown;

    if (serverMeta?.operation) {
      resPayload[OPERATION_EVENT_KEY] = serverMeta.operation;
    }

    return resPayload;
  } catch (error) {
    cleanupDelegationPeer(options, error);
    const base = {
      ts: nowMs(),
      op: timings.requestType,
      kind: "delegation" as const,
      profileId: timings.profileId,
    };
    recordFailure(base, timings.requestStart, error);
    throw error;
  }
}

export async function* stream<T extends Request>(
  request: T,
  rpc: RPC,
  options: DelegateOptions = {},
): AsyncGenerator<Response> {
  const { profilingMeta } = options;
  const shouldProfile = shouldProfileDelegation(request.type, profilingMeta);

  if (!shouldProfile) {
    yield* streamBase(request, rpc, options, profilingMeta);
    return;
  }
  yield* streamProfiled(request, rpc, options, profilingMeta);
}

async function* streamBase<T extends Request>(
  request: T,
  rpc: RPC,
  options: DelegateOptions = {},
  profilingMeta?: ProfilingRequestMeta,
): AsyncGenerator<Response> {
  try {
    const parsedRequest = requestSchema.parse(request);
    const req = rpc.request(getNextCommandId());

    logger.debug("[delegate-transport] Streaming:", { type: request.type });

    // Propagate per-call disable signal to delegated provider
    const finalRequest =
      profilingMeta?.enabled === false
        ? { ...parsedRequest, [PROFILING_KEY]: { enabled: false } }
        : parsedRequest;
    req.send(JSON.stringify(finalRequest), "utf-8");

    const responseStream = req.createResponseStream({ encoding: "utf-8" });
    let buffer = "";

    async function* processStream(): AsyncGenerator<Buffer> {
      for await (const chunk of responseStream as AsyncIterable<Buffer>) {
        yield chunk;
      }
    }

    const streamWithTimeout = withTimeoutStream(
      processStream(),
      options?.timeout,
    );

    for await (const chunk of streamWithTimeout) {
      buffer += chunk.toString();

      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        const rawPayload = JSON.parse(line) as Record<string, unknown>;
        if (rawPayload[PROFILING_TRAILER_KEY] === true) continue;
        const response = responseSchema.parse(stripProfilingMeta(rawPayload));
        checkAndThrowError(response);
        yield response;
      }
    }
  } catch (error) {
    cleanupDelegationPeer(options, error);
    throw error;
  }
}

async function* streamProfiled<T extends Request>(
  request: T,
  rpc: RPC,
  options: DelegateOptions = {},
  profilingMeta?: ProfilingRequestMeta,
): AsyncGenerator<Response> {
  const profileId = profilingMeta?.id ?? generateId();
  const timings: DelegationStreamTimings = createDelegationStreamTimings(
    profileId,
    request.type,
  );

  try {
    if (options.peerKey) {
      flushServerConnectionEvent(options.peerKey);
    }

    const parsedRequest = requestSchema.parse(request);
    const req = rpc.request(getNextCommandId());

    logger.debug("[delegate-transport] Streaming (profiled):", {
      type: request.type,
    });

    const stringifyStart = nowMs();
    const requestWithProfiling = {
      ...parsedRequest,
      [PROFILING_KEY]: { id: profileId },
    };
    const payload = JSON.stringify(requestWithProfiling);
    timings.requestStringifyMs = nowMs() - stringifyStart;

    timings.sendStart = nowMs();
    req.send(payload, "utf-8");

    const responseStream = req.createResponseStream({ encoding: "utf-8" });
    let buffer = "";

    async function* processStream(): AsyncGenerator<Buffer> {
      for await (const chunk of responseStream as AsyncIterable<Buffer>) {
        yield chunk;
      }
    }

    const streamWithTimeout = withTimeoutStream(
      processStream(),
      options?.timeout,
    );

    let lastServerMeta: ProfilingResponseMeta | undefined;

    for await (const chunk of streamWithTimeout) {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const rawPayload = JSON.parse(line) as Record<string, unknown>;

        const serverMeta = extractProfilingMeta(rawPayload);
        if (serverMeta) {
          lastServerMeta = serverMeta;
        }

        if (rawPayload[PROFILING_TRAILER_KEY] === true) continue;

        const response = responseSchema.parse(
          stripProfilingMeta(rawPayload),
        ) as ResponseWithDelegation;
        checkAndThrowError(response);

        timings.chunkCount++;
        if (timings.firstChunkAt === undefined) {
          timings.firstChunkAt = nowMs();
        }
        timings.lastChunkAt = nowMs();

        if (serverMeta?.operation) {
          response[OPERATION_EVENT_KEY] = serverMeta.operation;
        }

        response[DELEGATION_BREAKDOWN_KEY] =
          buildDelegationStreamBreakdown(timings);

        yield response;
      }
    }

    recordDelegationStreamEvents(timings, lastServerMeta);
  } catch (error) {
    cleanupDelegationPeer(options, error);
    const base = {
      ts: nowMs(),
      op: timings.requestType,
      kind: "delegation" as const,
      profileId: timings.profileId,
    };
    recordFailure(base, timings.requestStart, error);
    throw error;
  }
}
