/**
 * Generic wrappers for profiling handler execution.
 * Used to wrap dispatch/invoke functions with timing capture.
 */

import {
  PROFILING_KEY,
  OPERATION_EVENT_KEY,
  type PerCallProfiling,
  type ProfilingRequestMeta,
  type OperationEvent,
} from "@/schemas";
import { nowMs, generateProfileId } from "@/profiling/clock";
import { record, shouldProfile } from "@/profiling/controller";
import { buildOperationEvent } from "./operation-metrics";
import { isTerminalChunk } from "../handler-utils";

type ResponseWithOperationEvent<T> = T & { [OPERATION_EVENT_KEY]?: OperationEvent };

export interface ProfiledReplyOptions<TRequest> {
  op: string;
  request: TRequest;
  perCall?: PerCallProfiling;
}

export interface ProfiledStreamOptions<TRequest> {
  op: string;
  request: TRequest;
  perCall?: PerCallProfiling;
}

interface RecordOperationEventParams<TRequest, TResponse> {
  options: ProfiledReplyOptions<TRequest> | ProfiledStreamOptions<TRequest>;
  profileId: string;
  startTs: number;
  executionMs: number;
  finalResponse?: TResponse | undefined;
  ttfb?: number | undefined;
  count?: number | undefined;
  errored?: boolean | undefined;
}

function getRequestProfilingMeta(
  request: unknown,
): ProfilingRequestMeta | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const meta = (request as Record<string, unknown>)[PROFILING_KEY];
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  return meta as ProfilingRequestMeta;
}

function resolvePerCallProfiling<TRequest>(
  options: ProfiledReplyOptions<TRequest> | ProfiledStreamOptions<TRequest>,
): PerCallProfiling | undefined {
  if (options.perCall) {
    return options.perCall;
  }

  const meta = getRequestProfilingMeta(options.request);
  if (!meta) {
    return undefined;
  }

  if (meta.enabled === false) {
    return { enabled: false };
  }

  return {
    enabled: true,
    includeServerBreakdown: meta.includeServer,
    mode: meta.mode,
  };
}

function buildAndRecordOperationEvent<TRequest, TResponse>(
  params: RecordOperationEventParams<TRequest, TResponse>,
): OperationEvent | undefined {
  const event = buildOperationEvent(
    params.options.op,
    params.profileId,
    params.startTs,
    params.executionMs,
    params.options.request,
    params.finalResponse,
    params.ttfb,
  );

  if (!event) return undefined;

  if (params.errored) {
    event.tags = { ...event.tags, error: "true" };
  }

  if (params.count !== undefined && params.count > 0) {
    event.count = params.count;
  }

  record(event);

  return event as OperationEvent;
}

export async function profileReplyHandler<TRequest, TResponse>(
  options: ProfiledReplyOptions<TRequest>,
  handler: () => Promise<TResponse>,
): Promise<TResponse> {
  const perCall = resolvePerCallProfiling(options);
  if (!shouldProfile(options.op, perCall)) {
    return handler();
  }

  const profileId = generateProfileId();
  const startTs = nowMs();

  try {
    const result = await handler();
    const executionMs = nowMs() - startTs;
    const event = buildAndRecordOperationEvent({
      options,
      profileId,
      startTs,
      executionMs,
      finalResponse: result,
    });

    if (event) {
      (result as ResponseWithOperationEvent<TResponse>)[OPERATION_EVENT_KEY] = event;
    }

    return result;
  } catch (error) {
    const executionMs = nowMs() - startTs;
    buildAndRecordOperationEvent({
      options,
      profileId,
      startTs,
      executionMs,
      errored: true,
    });

    throw error;
  }
}

export async function* profileStreamHandler<TRequest, TResponse, TReturn = unknown>(
  options: ProfiledStreamOptions<TRequest>,
  handler: () => AsyncGenerator<TResponse, TReturn>,
): AsyncGenerator<TResponse, TReturn> {
  const perCall = resolvePerCallProfiling(options);
  if (!shouldProfile(options.op, perCall)) {
    return yield* handler();
  }

  const profileId = generateProfileId();
  const startTs = nowMs();
  let ttfb: number | undefined;
  let lastChunk: TResponse | undefined;
  let chunkCount = 0;
  let eventAttached = false;

  const iterator = handler();
  try {
    while (true) {
      const result = await iterator.next();
      if (result.done) {
        if (!eventAttached) {
          const executionMs = nowMs() - startTs;
          buildAndRecordOperationEvent({
            options,
            profileId,
            startTs,
            executionMs,
            finalResponse: lastChunk,
            ttfb,
            count: chunkCount,
          });
        }

        return result.value;
      }

      const chunk = result.value;
      if (ttfb === undefined) {
        ttfb = nowMs() - startTs;
      }
      chunkCount++;
      lastChunk = chunk;

      if (!eventAttached && isTerminalChunk(chunk)) {
        const executionMs = nowMs() - startTs;
        const event = buildAndRecordOperationEvent({
          options,
          profileId,
          startTs,
          executionMs,
          finalResponse: chunk,
          ttfb,
          count: chunkCount,
        });

        if (event) {
          (chunk as ResponseWithOperationEvent<TResponse>)[OPERATION_EVENT_KEY] = event;
        }

        eventAttached = true;
      }

      yield chunk;
    }
  } catch (error) {
    const executionMs = nowMs() - startTs;
    buildAndRecordOperationEvent({
      options,
      profileId,
      startTs,
      executionMs,
      finalResponse: lastChunk,
      ttfb,
      count: chunkCount,
      errored: true,
    });

    throw error;
  } finally {
    await iterator.return?.(undefined as TReturn);
  }
}
