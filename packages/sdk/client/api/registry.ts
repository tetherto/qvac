import type {
  ModelRegistryListRequest,
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
  ModelRegistryEntry,
  ModelRegistryEntryAddon,
} from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import { ModelRegistryQueryFailedError } from "@/utils/errors-client";

export type { ModelRegistryEntry, ModelRegistryEntryAddon };

export interface ModelRegistrySearchParams {
  filter?: string;
  engine?: string;
  quantization?: string;
  modelType?: ModelRegistryEntryAddon;
  addon?: ModelRegistryEntryAddon;
}

interface RegistryResponse {
  success?: boolean | undefined;
  error?: string | undefined;
}

function validateRegistryResponse(
  response: RegistryResponse,
  fallbackError?: string,
): void {
  if (!response.success) {
    throw new ModelRegistryQueryFailedError(
      response.error ?? fallbackError ?? "Unknown registry error",
    );
  }
}

/**
 * Returns all available models from the QVAC distributed model registry.
 *
 * @returns Array of all models in the registry.
 *
 * @throws {QVAC_MODEL_REGISTRY_QUERY_FAILED} The registry query fails
 *
 * @example
 * ```typescript
 * import { modelRegistryList } from "@qvac/sdk";
 *
 * const models = await modelRegistryList();
 * for (const model of models) {
 *   console.log(model.registryPath, model.addon);
 * }
 * ```
 */
async function modelRegistryList(): Promise<ModelRegistryEntry[]> {
  const request: ModelRegistryListRequest = {
    type: "modelRegistryList",
  };

  const response = (await send(request)) as ModelRegistryListResponse;
  validateRegistryResponse(response);

  return response.models!;
}

/**
 * Searches the QVAC model registry with optional filters.
 *
 * @param params - Optional search filters. If omitted, returns all models.
 * @returns Matching model entries.
 *
 * @throws {QVAC_MODEL_REGISTRY_QUERY_FAILED} The registry query fails
 *
 * @example
 * ```typescript
 * // Search LLM models
 * const llmModels = await modelRegistrySearch({ modelType: "llm" });
 *
 * // Search by name
 * const llamaModels = await modelRegistrySearch({ filter: "llama" });
 *
 * // Combined filters
 * const models = await modelRegistrySearch({
 *   modelType: "llm",
 *   quantization: "Q4_K_M",
 * });
 * ```
 */
async function modelRegistrySearch(
  params: ModelRegistrySearchParams = {},
): Promise<ModelRegistryEntry[]> {
  const { modelType, ...rest } = params;
  const request: ModelRegistrySearchRequest = {
    type: "modelRegistrySearch",
    ...rest,
    addon: modelType ?? rest.addon,
  };

  const response = (await send(request)) as ModelRegistrySearchResponse;
  validateRegistryResponse(response);

  return response.models!;
}

/**
 * Retrieves a single model entry from the QVAC model registry by path and
 * source.
 *
 * @param registryPath - The registry path of the model
 * @param registrySource - The registry source identifier
 * @returns The matching model entry.
 *
 * @throws {QVAC_MODEL_REGISTRY_QUERY_FAILED} The registry query fails or model is not found
 *
 * @example
 * ```typescript
 * const model = await modelRegistryGetModel("llama-3.2-3b-q4", "qvac");
 * console.log(model.name, model.expectedSize);
 * ```
 */
async function modelRegistryGetModel(
  registryPath: string,
  registrySource: string,
): Promise<ModelRegistryEntry> {
  const request: ModelRegistryGetModelRequest = {
    type: "modelRegistryGetModel",
    registryPath,
    registrySource,
  };

  const response = (await send(request)) as ModelRegistryGetModelResponse;
  validateRegistryResponse(
    response,
    `Model not found: ${registrySource}/${registryPath}`,
  );

  return response.model!;
}

export { modelRegistryList, modelRegistrySearch, modelRegistryGetModel };
