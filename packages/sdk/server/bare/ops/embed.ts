import { getModel } from "@/server/bare/registry/model-registry";
import { type EmbedParams, type EmbedStats, embedParamsSchema } from "@/schemas";
import { buildUnaryResult } from "@/profiling/model-execution";
import {
  EmbedNoEmbeddingsError,
  EmbedFailedError,
} from "@/utils/errors-server";
import { nowMs } from "@/profiling";
import type { EmbedResponse } from "@/server/bare/types/addon-responses";

export interface EmbedResult {
  embedding: number[] | number[][];
  stats?: EmbedStats;
}


// Overloaded functions for embedding
export async function embed(params: {
  modelId: string;
  text: string;
}): Promise<EmbedResult>;
export async function embed(params: {
  modelId: string;
  text: string[];
}): Promise<EmbedResult>;
export async function embed(params: EmbedParams): Promise<EmbedResult>;

export async function embed(params: EmbedParams): Promise<EmbedResult> {
  const { modelId, text } = embedParamsSchema.parse(params);
  const model = getModel(modelId);

  const modelStart = nowMs();
  const response = (await model.run(text)) as unknown as EmbedResponse;
  const rawEmbeddings = await response.await();
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
