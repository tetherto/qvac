import type {
  ModelRegistryListRequest,
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
  ModelRegistryEntry,
  ModelRegistryEntryAddon,
  RPCOptions
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { ModelRegistryQueryFailedError } from '@/utils/errors-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decoratePromise } from '@/utils/decorate-promise'

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

/** A registry query's result, with the id that `cancel({ requestId })` takes. */
export type RegistryQuery<T> = Promise<T> & { requestId: string }

function validateRegistryResponse(response: RegistryResponse): void {
  if (!response.success) {
    throw new ModelRegistryQueryFailedError(response.error ?? 'Unknown registry error')
  }
}

/**
 * Returns all available models from the QVAC distributed model registry.
 *
 * @returns A promise resolving to an array of `ModelRegistryEntry` describing every model the SDK's connected registry knows about,
 *   decorated with a synchronous `requestId` for `cancel({ requestId })` while the query waits for the registry.
 * @throws {ModelRegistryBusyError} When another QVAC process kept the registry for longer than the query waits.
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
function modelRegistryList(options?: RPCOptions): RegistryQuery<ModelRegistryEntry[]> {
  const requestId = generateClientRequestId()
  return decoratePromise(runList(requestId, options), { requestId })
}

async function runList(requestId: string, options?: RPCOptions): Promise<ModelRegistryEntry[]> {
  const request: ModelRegistryListRequest = {
    type: 'modelRegistryList',
    requestId
  }

  const response = (await send(request, options)) as ModelRegistryListResponse
  validateRegistryResponse(response)

  return response.models!
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
 * @returns A promise resolving to the matching `ModelRegistryEntry` entries, decorated with a
 *   synchronous `requestId` for `cancel({ requestId })` while the query waits for the registry.
 * @throws {ModelRegistryBusyError} When another QVAC process kept the registry for longer than the query waits.
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
function modelRegistrySearch(
  params: ModelRegistrySearchParams = {},
  options?: RPCOptions
): RegistryQuery<ModelRegistryEntry[]> {
  const requestId = generateClientRequestId()
  return decoratePromise(runSearch(params, requestId, options), { requestId })
}

async function runSearch(
  params: ModelRegistrySearchParams,
  requestId: string,
  options?: RPCOptions
): Promise<ModelRegistryEntry[]> {
  const { modelType, ...rest } = params
  const request: ModelRegistrySearchRequest = {
    type: 'modelRegistrySearch',
    ...rest,
    addon: modelType ?? rest.addon,
    requestId
  }

  const response = (await send(request, options)) as ModelRegistrySearchResponse
  validateRegistryResponse(response)

  return response.models!
}

/**
 * Fetches a single model entry from the registry by its path and source.
 *
 * @param registryPath - Registry-relative path of the model to fetch.
 * @param registrySource - Registry source identifier (e.g., `"huggingface"`, `"local"`).
 * @returns A promise resolving to the matching `ModelRegistryEntry`, decorated with a
 *   synchronous `requestId` for `cancel({ requestId })` while the query waits for the registry.
 * @throws {ModelRegistryModelNotFoundError} When the registry has no model at this source and path.
 * @throws {ModelRegistryBusyError} When another QVAC process kept the registry for longer than the query waits.
 * @throws {ModelRegistryQueryFailedError} When the registry query fails.
 */
function modelRegistryGetModel(
  registryPath: string,
  registrySource: string,
  options?: RPCOptions
): RegistryQuery<ModelRegistryEntry> {
  const requestId = generateClientRequestId()
  return decoratePromise(runGetModel(registryPath, registrySource, requestId, options), {
    requestId
  })
}

async function runGetModel(
  registryPath: string,
  registrySource: string,
  requestId: string,
  options?: RPCOptions
): Promise<ModelRegistryEntry> {
  const request: ModelRegistryGetModelRequest = {
    type: 'modelRegistryGetModel',
    registryPath,
    registrySource,
    requestId
  }

  const response = (await send(request, options)) as ModelRegistryGetModelResponse
  validateRegistryResponse(response)

  return response.model!
}

export { modelRegistryList, modelRegistrySearch, modelRegistryGetModel }
