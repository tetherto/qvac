import type {
  ModelRegistryListRequest,
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
  ModelRegistryEntry,
  ModelRegistryEntryAddon
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { ModelRegistryQueryFailedError } from '@/utils/errors-client'

export type { ModelRegistryEntry, ModelRegistryEntryAddon }

export interface ModelRegistrySearchParams {
  filter?: string
  engine?: string
  quantization?: string
  modelType?: ModelRegistryEntryAddon
  addon?: ModelRegistryEntryAddon
}

interface RegistryResponse {
  success?: boolean | undefined
  error?: string | undefined
}

function validateRegistryResponse(response: RegistryResponse): void {
  if (!response.success) {
    throw new ModelRegistryQueryFailedError(response.error ?? 'Unknown registry error')
  }
}

/**
 * Returns all available models from the QVAC distributed model registry.
 *
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
async function modelRegistryList(): Promise<ModelRegistryEntry[]> {
  const request: ModelRegistryListRequest = {
    type: 'modelRegistryList'
  }

  const response = (await send(request)) as ModelRegistryListResponse
  validateRegistryResponse(response)

  return response.models!
}

/**
 * Searches the model registry with optional filters for model type, engine, and quantization.
 *
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
async function modelRegistrySearch(
  params: ModelRegistrySearchParams = {}
): Promise<ModelRegistryEntry[]> {
  const { modelType, ...rest } = params
  const request: ModelRegistrySearchRequest = {
    type: 'modelRegistrySearch',
    ...rest,
    addon: modelType ?? rest.addon
  }

  const response = (await send(request)) as ModelRegistrySearchResponse
  validateRegistryResponse(response)

  return response.models!
}

/**
 * Fetches a single model entry from the registry by its path and source.
 *
 * @throws {ModelRegistryModelNotFoundError} When the registry has no model at this source and path.
 *
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
async function modelRegistryGetModel(
  registryPath: string,
  registrySource: string
): Promise<ModelRegistryEntry> {
  const request: ModelRegistryGetModelRequest = {
    type: 'modelRegistryGetModel',
    registryPath,
    registrySource
  }

  const response = (await send(request)) as ModelRegistryGetModelResponse
  validateRegistryResponse(response)

  return response.model!
}

export { modelRegistryList, modelRegistrySearch, modelRegistryGetModel }
