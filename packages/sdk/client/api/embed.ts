import { send } from "@/client/rpc/rpc-client";
import {
  type EmbedParams,
  type EmbedRequest,
  type EmbedStats,
  type RPCOptions,
} from "@/schemas";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Generates embeddings for a single text using a specified model.
 *
 * @overloadLabel "Single text"
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input text to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise resolving to an object with `embedding` (a single `number[]` vector) and optional `stats` performance data.
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export async function embed(
  params: { modelId: string; text: string },
  options?: RPCOptions,
): Promise<{ embedding: number[]; stats?: EmbedStats }>;

/**
 * Generates embeddings for multiple texts using a specified model.
 *
 * @overloadLabel "Multiple texts"
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input texts to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise resolving to an object with `embedding` (one `number[]` vector per input text, i.e. `number[][]`) and optional `stats` performance data.
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export async function embed(
  params: { modelId: string; text: string[] },
  options?: RPCOptions,
): Promise<{ embedding: number[][]; stats?: EmbedStats }>;

export async function embed(
  params: EmbedParams,
  options?: RPCOptions,
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> {
  const request: EmbedRequest = {
    type: "embed",
    ...params,
  };

  const response = await send(request, options);
  if (response.type !== "embed") {
    throw new InvalidResponseError("embed");
  }

  return {
    embedding: response.embedding,
    ...(response.stats !== undefined && { stats: response.stats }),
  };
}
