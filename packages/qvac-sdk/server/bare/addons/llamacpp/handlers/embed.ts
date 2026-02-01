import { getModel } from "@/server/bare/registry/model-registry";
import { type EmbedParams, embedParamsSchema } from "@/schemas";
import {
  EmbedNoEmbeddingsError,
  EmbedFailedError,
} from "@/utils/errors-server";

// Overloaded functions for embedding
export async function embed(params: {
  modelId: string;
  text: string;
}): Promise<number[]>;
export async function embed(params: {
  modelId: string;
  text: string[];
}): Promise<number[][]>;
export async function embed(
  params: EmbedParams,
): Promise<number[] | number[][]>;

export async function embed(
  params: EmbedParams,
): Promise<number[] | number[][]> {
  const { modelId, text } = embedParamsSchema.parse(params);
  const model = getModel(modelId);
  const response = await model.run(text);
  const rawEmbeddings = (await response.await()) as unknown as Float32Array[][];
  const embeddingsArray = rawEmbeddings[0];

  if (Array.isArray(text)) {
    if (!embeddingsArray || embeddingsArray.length === 0) {
      throw new EmbedNoEmbeddingsError();
    }

    return embeddingsArray.map((embeddingVector) => {
      if (!embeddingVector || embeddingVector.length === 0) {
        throw new EmbedNoEmbeddingsError();
      }
      return normalizeVector(embeddingVector);
    });
  } else {
    const embeddingVector = embeddingsArray?.[0];
    if (!embeddingVector || embeddingVector.length === 0) {
      throw new EmbedNoEmbeddingsError();
    }

    return normalizeVector(embeddingVector);
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
