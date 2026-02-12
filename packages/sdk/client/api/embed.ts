import { send } from "@/client/rpc/rpc-client";
import { type EmbedParams, type EmbedRequest } from "@/schemas";
import { InvalidResponseError, EmbedFailedError } from "@/utils/errors-client";

/**
 * Generates embeddings for a single text using a specified model.
 *
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input text to embed
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export async function embed(params: {
  modelId: string;
  text: string;
}): Promise<number[]>;

/**
 * Generates embeddings for multiple texts using a specified model.
 *
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input texts to embed
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export async function embed(params: {
  modelId: string;
  text: string[];
}): Promise<number[][]>;

export async function embed(
  params: EmbedParams,
): Promise<number[] | number[][]> {
  const request: EmbedRequest = {
    type: "embed",
    ...params,
  };

  const response = await send(request);
  if (response.type !== "embed") {
    throw new InvalidResponseError("embed");
  }

  if (!response.success) {
    throw new EmbedFailedError(response.error);
  }

  return response.embedding;
}
