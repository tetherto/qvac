import { ModelAlreadyRegisteredError, ModelNotFoundError } from '@/errors/index'
import type { CanonicalModelType } from '@/schemas/index'
import { getEngineLogger } from '@/logging/index'

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
  modelType: CanonicalModelType
  name?: string | undefined
}

export type ModelEntry = { id: string; local: LocalOptions }

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
  }
): void {
  if (modelRegistry.has(id)) {
    throw new ModelAlreadyRegisteredError(id)
  }

  modelRegistry.set(id, {
    id,
    local: {
      model: options.model,
      path: options.path,
      loadedAt: new Date(),
      config: options.config,
      modelType: options.modelType,
      name: options.name
    }
  })

  const nameStr = options.name ? ` (${options.name})` : ''
  logger.info(`Local model registered: ${id}${nameStr} -> ${options.path}`)
}

export function getModelEntry(id: string): ModelEntry | null {
  return modelRegistry.get(id) || null
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
