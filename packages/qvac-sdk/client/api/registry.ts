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

async function modelRegistryList(): Promise<ModelRegistryEntry[]> {
  const request: ModelRegistryListRequest = {
    type: "modelRegistryList",
  };

  const response = (await send(request)) as ModelRegistryListResponse;
  validateRegistryResponse(response);

  return response.models!;
}

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
