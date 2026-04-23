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
 * @returns A promise resolving to an array of `ModelRegistryEntry` describing every model the SDK's connected registry knows about.
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
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
 * Searches the model registry with optional filters for model type, engine, and quantization.
 *
 * @param params - Search filters (all optional).
 * @param params.filter - Free-text filter matched against model metadata.
 * @param params.engine - Inference engine identifier (e.g., `"llamacpp-completion"`).
 * @param params.quantization - Quantization identifier (e.g., `"Q4_K_M"`).
 * @param params.modelType - Alias for `addon`; kept for backward compatibility.
 * @param params.addon - Model addon / category to restrict results to.
 * @returns A promise resolving to the matching `ModelRegistryEntry` entries.
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
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
 * Fetches a single model entry from the registry by its path and source.
 *
 * @param registryPath - Registry-relative path of the model to fetch.
 * @param registrySource - Registry source identifier (e.g., `"huggingface"`, `"local"`).
 * @returns A promise resolving to the matching `ModelRegistryEntry`.
 * @throws {ModelRegistryQueryFailedError} When the model cannot be located or the registry query fails.
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
