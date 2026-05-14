import { getModel } from "@/server/bare/registry/model-registry";
import { type EmbedParams, type EmbedStats, embedParamsSchema } from "@/schemas";
import { buildUnaryResult } from "@/profiling/model-execution";
import {
  EmbedNoEmbeddingsError,
  EmbedFailedError,
  InferenceCancelledError,
} from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import type { EmbedResponse } from "@/server/bare/types/addon-responses";
import {
  getRequestRegistry,
  withRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import { getServerLogger } from "@/logging";

export interface EmbedResult {
  embedding: number[] | number[][];
  stats?: EmbedStats;
}

// Overloaded functions for embedding
export async function embed(
  params: { modelId: string; text: string },
  requestId?: string,
): Promise<EmbedResult>;
export async function embed(
  params: { modelId: string; text: string[] },
  requestId?: string,
): Promise<EmbedResult>;
export async function embed(
  params: EmbedParams,
  requestId?: string,
): Promise<EmbedResult>;

export async function embed(
  params: EmbedParams,
  requestId?: string,
): Promise<EmbedResult> {
  const { modelId, text } = embedParamsSchema.parse(params);

  // Open a request-scoped lifecycle. The registry routes
  // `cancel({ requestId })` and broad `cancel({ modelId, kind: "embeddings" })`
  // straight to this context's signal. Falls back to a server-generated
  // id if the client didn't send one (older releases).
  await using ctx = getRequestRegistry().begin({
    requestId: requestId ?? generateServerRequestId(),
    kind: "embeddings",
    modelId,
  });
  // `requestLogger` is intentionally referenced once so the
  // request-scoped logger is built at handler entry per the canonical
  // shape, even when this op has no per-step emits beyond the
  // registry's own lifecycle lines. Future addon-level warns inside
  // this body should route through `requestLogger`.
  const requestLogger = withRequestContext(getServerLogger(), ctx);

  const model = getModel(modelId);

  // Hard-cancel wiring: llamacpp-embedding declares
  // `cancel: { scope: "model", hard: true }`. The signal listener
  // forwards an abort to the addon so C++ work stops as soon as the
  // user cancels — mirrors the canonical handler shape documented in
  // `request-lifecycle-primitives.mdc`. The post-await
  // `signal.aborted` checks below are the soft-cancel safety net for
  // the case where the abort fires between `model.run(...)` returning
  // and `response.await()` resolving (both can take seconds on large
  // batches).
  const onAbort = () => {
    const addon = model.addon;
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  // `{ once: true }` does not fire if the signal is already aborted at
  // register time. The registry may abort synchronously when a
  // cancel-before-begin race resolves or the parent signal was pre-
  // aborted — re-use `onAbort` so the listener body is the single
  // source of truth for "what cancel does."
  if (ctx.signal.aborted) onAbort();
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener("abort", onAbort);
  });

  const modelStart = nowMs();
  const response = (await model.run(text)) as unknown as EmbedResponse;
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId);
  }
  const rawEmbeddings = await response.await();
  if (ctx.signal.aborted) {
    throw new InferenceCancelledError(ctx.requestId);
  }
  const modelExecutionMs = nowMs() - modelStart;

  const stats: EmbedStats = {
    ...(response.stats?.total_time_ms !== undefined && { totalTime: response.stats.total_time_ms }),
    ...(response.stats?.tokens_per_second !== undefined && { tokensPerSecond: response.stats.tokens_per_second }),
    ...(response.stats?.total_tokens !== undefined && { totalTokens: response.stats.total_tokens }),
    ...(response.stats?.backendDevice !== undefined && { backendDevice: response.stats.backendDevice }),
  };

  const embeddingsArray = rawEmbeddings[0];

  if (Array.isArray(text)) {
    if (!embeddingsArray || embeddingsArray.length === 0) {
      throw new EmbedNoEmbeddingsError();
    }

    const embedding = embeddingsArray.map((embeddingVector) => {
      if (!embeddingVector || embeddingVector.length === 0) {
        throw new EmbedNoEmbeddingsError();
      }
      return normalizeVector(embeddingVector);
    });
    return buildUnaryResult({ embedding }, modelExecutionMs, stats);
  } else {
    const embeddingVector = embeddingsArray?.[0];
    if (!embeddingVector || embeddingVector.length === 0) {
      throw new EmbedNoEmbeddingsError();
    }

    return buildUnaryResult({ embedding: normalizeVector(embeddingVector) }, modelExecutionMs, stats);
  }
}

export function normalizeVector(vector: Float32Array) {
  let sumOfSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!;
    if (!Number.isFinite(value)) {
      throw new EmbedFailedError(
        `NormalizeVector: non-finite value at index ${i}: ${value}`,
      );
    }
    sumOfSquares += value * value;
  }

  const magnitude = Math.sqrt(sumOfSquares);
  const EPS_ZERO = 1e-12;
  const UNIT_TOL = 1e-4;

  // Handle bad norms
  if (!Number.isFinite(magnitude) || magnitude < EPS_ZERO) {
    return new Array(vector.length).fill(0) as number[];
  }

  // Early exit: already ~unit length
  if (Math.abs(magnitude - 1) <= UNIT_TOL) {
    return Array.from(vector);
  }

  const inverseMagnitude = 1 / magnitude;
  const normalizedVector = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    normalizedVector[i] = vector[i]! * inverseMagnitude;
  }
  return normalizedVector as number[];
}
