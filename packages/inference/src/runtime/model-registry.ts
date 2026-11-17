import { ModelAlreadyRegisteredError, ModelNotFoundError } from '@/errors/index'
import type { CanonicalModelType, ModelFitProbe, ToolDialect } from '@/schemas/index'
import { getEngineLogger } from '@/logging/index'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { canonicalConfigString } from '@/utils/formatting'

const logger = getEngineLogger()

interface AddonInterface {
  cancel(jobId?: string): Promise<void>
}

interface ModelRunResponse {
  iterate(): AsyncIterable<unknown>
  await(): Promise<unknown>
  // Cancels just this run's job, leaving concurrent peers on the model decoding.
  cancel(): Promise<void>
}

export interface AnyModel {
  load(force?: boolean): Promise<void>
  run(...args: unknown[]): Promise<ModelRunResponse>
  unload(): void | Promise<void>
  destroy?(): void | Promise<void>
  pause(): void | Promise<void>
  unpause?(): void | Promise<void>
  stop?(): void | Promise<void>
  status?(): Promise<string>
  reload?(config: unknown): Promise<void>
  addon?: AddonInterface
}

interface LocalOptions {
  model: AnyModel
  path: string
  loadedAt: Date
  config: unknown
  /** The configuration the model was loaded with, which its id is a hash of. */
  loadedConfig: unknown
  modelType: CanonicalModelType
  name?: string | undefined
  fitProbe?: ModelFitProbe | undefined
  toolDialect?: ToolDialect | undefined
}

/**
 * `leases` holds the ids of the caller sessions that loaded the model and have
 * not unloaded it. The model leaves memory when the set empties or on root
 * shutdown.
 */
export type ModelEntry = { id: string; local: LocalOptions; leases: Set<string> }

// Global registry state - using stateless functions to manage it
const modelRegistry = new Map<string, ModelEntry>()

export function registerModel(
  id: string,
  options: {
    model: AnyModel
    path: string
    config: unknown
    modelType: CanonicalModelType
    name?: string | undefined
    fitProbe?: ModelFitProbe | undefined
    toolDialect?: ToolDialect | undefined
  },
  sessionId: string = OWNER_SESSION_ID
): void {
  if (modelRegistry.has(id)) {
    throw new ModelAlreadyRegisteredError(id)
  }

  modelRegistry.set(id, {
    id,
    leases: new Set([sessionId]),
    local: {
      model: options.model,
      path: options.path,
      loadedAt: new Date(),
      config: options.config,
      loadedConfig: options.config,
      modelType: options.modelType,
      name: options.name,
      fitProbe: options.fitProbe,
      toolDialect: options.toolDialect
    }
  })

  const nameStr = options.name ? ` (${options.name})` : ''
  logger.info(`Local model registered: ${id}${nameStr} -> ${options.path}`)
}

export function getModelEntry(id: string): ModelEntry | null {
  return modelRegistry.get(id) || null
}

/** Records that `sessionId` holds the model. Idempotent per session. */
export function addModelLease(id: string, sessionId: string): void {
  const entry = modelRegistry.get(id)
  if (!entry) {
    throw new ModelNotFoundError(id)
  }
  entry.leases.add(sessionId)
}

/**
 * Drops `sessionId`'s lease. Returns the number of leases left, or `null` when
 * the session held none, so the caller can tell "released, model stays" from
 * "nothing to release".
 */
export function releaseModelLease(id: string, sessionId: string): number | null {
  const entry = modelRegistry.get(id)
  if (!entry || !entry.leases.has(sessionId)) return null
  entry.leases.delete(sessionId)
  return entry.leases.size
}

/** Ids of the models `sessionId` holds a lease on. */
export function getModelIdsLeasedBy(sessionId: string): string[] {
  const ids: string[] = []
  for (const entry of modelRegistry.values()) {
    if (entry.leases.has(sessionId)) ids.push(entry.id)
  }
  return ids
}

export function getModel(id: string): AnyModel {
  const entry = modelRegistry.get(id)
  if (!entry) {
    throw new ModelNotFoundError(id)
  }
  return entry.local.model
}

export function isModelLoaded(id: string): boolean {
  return modelRegistry.has(id)
}

export function unregisterModel(id: string): ModelEntry | null {
  const entry = modelRegistry.get(id)
  if (entry) {
    modelRegistry.delete(id)
    logger.debug(`Model unregistered: ${id}`)
    return entry
  }
  return null
}

export function getAllModelIds(): string[] {
  return Array.from(modelRegistry.keys())
}

export function getModelInfo(id: string): {
  id: string
  path: string
  loadedAt: Date
  config: unknown
  name?: string
} | null {
  const entry = modelRegistry.get(id)
  if (!entry) {
    return null
  }

  const result: {
    id: string
    path: string
    loadedAt: Date
    config: unknown
    name?: string
  } = {
    id: entry.id,
    path: entry.local.path,
    loadedAt: entry.local.loadedAt,
    config: entry.local.config
  }

  if (entry.local.name) {
    result.name = entry.local.name
  }

  return result
}

export function getModelConfig(id: string): unknown {
  const entry = modelRegistry.get(id)
  if (!entry) {
    throw new ModelNotFoundError(id)
  }
  return entry.local.config
}

/**
 * Whether a reload left the model with a configuration other than the one it
 * was loaded with. Its id still hashes the loaded configuration, so a load of
 * that configuration would otherwise get the reconfigured model.
 */
export function isModelReconfigured(id: string): boolean {
  const entry = modelRegistry.get(id)
  if (!entry) return false
  return (
    canonicalConfigString(entry.local.config as Record<string, unknown> | undefined) !==
    canonicalConfigString(entry.local.loadedConfig as Record<string, unknown> | undefined)
  )
}

export function updateModelConfig(id: string, config: unknown): void {
  const entry = modelRegistry.get(id)
  if (!entry) {
    throw new ModelNotFoundError(id)
  }
  entry.local.config = config
}

export function clearRegistry(): void {
  modelRegistry.clear()
  logger.info('Model registry cleared')
}

export function getRegistryStats(): {
  totalModels: number
  modelIds: string[]
} {
  return {
    totalModels: modelRegistry.size,
    modelIds: Array.from(modelRegistry.keys())
  }
}

export async function unloadAllModels(): Promise<void> {
  const modelIds = getAllModelIds()

  for (const modelId of modelIds) {
    const entry = modelRegistry.get(modelId)
    try {
      if (entry) {
        if (entry.local.model.unload) {
          await entry.local.model.unload()
        }
        logger.debug(`Model unloaded: ${modelId}`)
      }
    } catch (error) {
      logger.error(
        `Error unloading model ${modelId}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
    modelRegistry.delete(modelId)
  }

  logger.info(`Unloaded ${modelIds.length} models`)
}
