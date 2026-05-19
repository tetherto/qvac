import { send } from "@/client/rpc/rpc-client";
import {
  type EmbedParams,
  type EmbedRequest,
  type EmbedStats,
  type RPCOptions,
} from "@/schemas";
import { InvalidResponseError } from "@/utils/errors-client";
import { decoratePromise } from "@/utils/decorate-promise";
import { generateClientRequestId } from "@/client/api/client-request-id";

/**
 * Generates embeddings for a single text using a specified model.
 *
 * @overloadLabel "Single text"
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input text to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise (decorated with `requestId`) resolving to an object with `embedding` (a single `number[]` vector) and optional `stats` performance data.
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export function embed(
  params: { modelId: string; text: string },
  options?: RPCOptions,
): Promise<{ embedding: number[]; stats?: EmbedStats }> & { requestId: string };

/**
 * Generates embeddings for multiple texts using a specified model.
 *
 * @overloadLabel "Multiple texts"
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input texts to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise (decorated with `requestId`) resolving to an object with `embedding` (one `number[]` vector per input text, i.e. `number[][]`) and optional `stats` performance data.
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export function embed(
  params: { modelId: string; text: string[] },
  options?: RPCOptions,
): Promise<{ embedding: number[][]; stats?: EmbedStats }> & {
  requestId: string;
};

export function embed(
  params: EmbedParams,
  options?: RPCOptions,
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> & {
  requestId: string;
} {
  // Client-generated `requestId` is surfaced synchronously on the
  // returned promise so the caller can `cancel({ requestId })` before
  // `await` resolves. The same id is threaded onto the wire envelope so
  // the server's registry entry uses it as the canonical key —
  // matching the `loadModel` / `downloadAsset` / `completion` shape.
  const requestId = generateClientRequestId();
  const inner = runEmbed(params, requestId, options);
  return decoratePromise(inner, { requestId });
}

async function runEmbed(
  params: EmbedParams,
  requestId: string,
  options?: RPCOptions,
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> {
  const request: EmbedRequest = {
    type: "embed",
    ...params,
    requestId,
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
