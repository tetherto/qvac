import type {
  ModelRegistryListRequest,
  ModelRegistryListResponse,
  ModelRegistrySearchRequest,
  ModelRegistrySearchResponse,
  ModelRegistryGetModelRequest,
  ModelRegistryGetModelResponse,
  ModelRegistryEntry
} from '@/schemas/index'
import Buffer from 'bare-buffer'
import type { QVACModelEntry } from '@qvac/registry-client'
import { REGISTRY_ERROR_CODES } from '@/schemas/errors'
import {
  getAddonFromEngine,
  resolveCanonicalEngine,
  resolveRegistryEngine
} from '@/schemas/engine-addon-map'
import { acquireRegistryClient } from '@/runtime/registry-client'
import { getRequestRegistry } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { resolveSessionId } from '@/runtime/session-id'
import { getEngineLogger } from '@/logging/index'
import {
  InferenceCancelledError,
  ModelRegistryBusyError,
  ModelRegistryModelNotFoundError,
  ModelRegistryQueryFailedError
} from '@/errors/index'

interface QvacError extends Error {
  code?: number
}

const logger = getEngineLogger()

function toHexString(value: Buffer | string | { data: number[] } | undefined): string {
  if (!value) return ''
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'data' in value) {
    return Buffer.from(value.data).toString('hex')
  }
  return ''
}

type RegistryClient = Awaited<ReturnType<typeof acquireRegistryClient>>['client']

// One query, cancellable by `requestId` while it waits for another process to
// release the registry.
async function withRegistryClient<T>(
  request: { requestId?: string | undefined; sessionId?: string | undefined },
  query: (client: RegistryClient) => Promise<T>
): Promise<T> {
  const id = request.requestId ?? generateRandomRequestId()
  await using ctx = await getRequestRegistry().begin({
    requestId: id,
    sessionId: resolveSessionId(request),
    kind: 'modelRegistry'
  })
  await using lease = await acquireRegistryClient({
    wait: 'query',
    signal: ctx.signal,
    cancelled: () => new InferenceCancelledError(id)
  })
  // Awaited here: returning the promise would release the lease before the query ends.
  return await query(lease.client)
}

// Errors a caller can act on pass through unwrapped.
function isPassThrough(error: unknown): boolean {
  const code = (error as QvacError).code
  return (
    error instanceof ModelRegistryBusyError ||
    error instanceof InferenceCancelledError ||
    code === REGISTRY_ERROR_CODES.FAILED_TO_CONNECT ||
    code === REGISTRY_ERROR_CODES.FAILED_TO_CLOSE ||
    code === REGISTRY_ERROR_CODES.MODEL_NOT_FOUND
  )
}

export function processRegistryModel(model: QVACModelEntry): ModelRegistryEntry | null {
  const engine = resolveRegistryEngine(model.engine || '', model.tags)
  if (!engine) {
    logger.warn(`Skipping model with unknown engine "${model.engine}": ${model.path}`)
    return null
  }

  const filename = model.path.split('/').pop() || model.path
  const blobBinding = model.blobBinding

  const blobCoreKey = toHexString(blobBinding?.coreKey)
  const blobBlockOffset = blobBinding?.blockOffset ?? 0
  const blobBlockLength = blobBinding?.blockLength ?? 0
  const blobByteOffset = blobBinding?.byteOffset ?? 0
  const expectedSize = blobBinding?.byteLength ?? 0
  // sha256 lives on blobBinding at runtime (per hyperschema), fall back to top-level
  const sha256Checksum =
    (blobBinding as unknown as Record<string, string>)?.['sha256'] || model.sha256 || ''

  const addon = getAddonFromEngine(engine)

  // Use the filename without extension as the display name
  const name = filename.replace(/\.\w+$/, '')

  return {
    name,
    registryPath: model.path,
    registrySource: model.source,
    blobCoreKey,
    blobBlockOffset,
    blobBlockLength,
    blobByteOffset,
    modelId: filename,
    addon,
    expectedSize,
    sha256Checksum,
    engine,
    quantization: model.quantization || '',
    params: model.params || ''
  }
}

export async function handleModelRegistryList(
  request: ModelRegistryListRequest = { type: 'modelRegistryList' }
): Promise<ModelRegistryListResponse> {
  logger.debug('Handling QVAC model registry list request')

  try {
    const registryModels = await withRegistryClient(request, (client) => client.findBy())
    const models = registryModels
      .map(processRegistryModel)
      .filter((m): m is ModelRegistryEntry => m !== null)

    logger.debug(`QVAC model registry list returned ${models.length} models`)

    return {
      type: 'modelRegistryList',
      success: true,
      models
    }
  } catch (error) {
    logger.error('QVAC model registry list failed:', error)
    if (isPassThrough(error)) throw error

    // Wrap unknown errors in a typed error
    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : 'Unknown error',
      error
    )
  }
}

export async function handleModelRegistrySearch(
  request: ModelRegistrySearchRequest
): Promise<ModelRegistrySearchResponse> {
  logger.debug('Handling QVAC model registry search request', request)

  try {
    const registryModels = await withRegistryClient(request, (client) =>
      client.findBy({
        ...(request.quantization && { quantization: request.quantization })
      })
    )

    let models = registryModels
      .map(processRegistryModel)
      .filter((m): m is ModelRegistryEntry => m !== null)

    if (request.engine) {
      const canonicalEngine = resolveCanonicalEngine(request.engine)
      models = models.filter((m) => m.engine === (canonicalEngine ?? request.engine))
    }

    if (request.filter) {
      const filterLower = request.filter.toLowerCase()
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(filterLower) ||
          m.registryPath.toLowerCase().includes(filterLower) ||
          m.addon.toLowerCase().includes(filterLower) ||
          m.engine.toLowerCase().includes(filterLower)
      )
    }

    if (request.addon) {
      models = models.filter((m) => m.addon === request.addon)
    }

    logger.debug(`QVAC model registry search returned ${models.length} models`)

    return {
      type: 'modelRegistrySearch',
      success: true,
      models
    }
  } catch (error) {
    logger.error('QVAC model registry search failed:', error)
    if (isPassThrough(error)) throw error

    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : 'Unknown error',
      error
    )
  }
}

export async function handleModelRegistryGetModel(
  request: ModelRegistryGetModelRequest
): Promise<ModelRegistryGetModelResponse> {
  logger.debug('Handling QVAC model registry get model request', request)

  try {
    const rawModel = await withRegistryClient(request, (client) =>
      client.getModel(request.registryPath, request.registrySource)
    )

    if (!rawModel) {
      throw new ModelRegistryModelNotFoundError(request.registrySource, request.registryPath)
    }

    const model = processRegistryModel(rawModel)

    if (!model) {
      throw new ModelRegistryQueryFailedError(
        `Model has unknown engine "${rawModel.engine}": ${request.registryPath}`
      )
    }

    logger.debug('QVAC model registry get model found:', model.name)

    return {
      type: 'modelRegistryGetModel',
      success: true,
      model
    }
  } catch (error) {
    if (error instanceof ModelRegistryModelNotFoundError) throw error

    logger.error('QVAC model registry get model failed:', error)
    if (isPassThrough(error)) throw error

    throw new ModelRegistryQueryFailedError(
      error instanceof Error ? error.message : 'Unknown error',
      error
    )
  }
}
