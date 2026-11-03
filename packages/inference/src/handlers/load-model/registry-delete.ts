import type { QVACBlobBinding } from '@qvac/registry-client'
import { promises as fsPromises } from 'bare-fs'
import { getModelByPath, type RegistryItem } from '@/models/registry/index'
import { registryUrlSchema } from '@/schemas/load-model'
import { getRegistryClient } from '@/runtime/registry-client'
import { getAllModelIds, getModelEntry } from '@/runtime/model-registry'
import { generateShortHash } from '@/utils/index'
import {
  getClearStorageTarget,
  getCompanionSetCacheDir,
  getShardedModelCacheDir,
  getSingleFileCachePath
} from '@/utils/cache/paths'
import { buildBlobBinding } from '@/handlers/load-model/registry-download-utils'
import {
  createRegistryDownloadKey,
  hasActiveTransfer
} from '@/handlers/load-model/download-manager'
import { DeleteCacheFailedError, InvalidDeleteCacheParamsError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

type BlobRange = Pick<QVACBlobBinding, 'coreKey' | 'blockOffset' | 'blockLength'>
type ClearableClient = { clearBlob?: (binding: BlobRange) => Promise<void> }

/**
 * Deletes a registry model's cached files and the corestore blocks a cancelled
 * or failed download kept for resume.
 */
export async function deleteRegistryModelCache(modelSrc: string): Promise<void> {
  const parsed = registryUrlSchema.safeParse(modelSrc)
  if (!parsed.success) throw new InvalidDeleteCacheParamsError()
  const { registryPath, registrySource } = parsed.data

  if (hasActiveTransfer(createRegistryDownloadKey(registrySource, registryPath))) {
    throw new DeleteCacheFailedError(`${modelSrc} is downloading; cancel it first`)
  }

  const entry = getModelByPath(registryPath)
  const catalogued = entry?.registrySource === registrySource ? entry : undefined
  const targets = getCacheTargets(registryPath, catalogued)

  for (const id of getAllModelIds()) {
    const loadedPath = getModelEntry(id)?.local.path
    if (loadedPath && targets.some((target) => loadedPath.startsWith(target))) {
      throw new DeleteCacheFailedError(`${modelSrc} is loaded; unload it with clearStorage instead`)
    }
  }

  // Read structurally: older registry clients have no clearBlob.
  const client = await getRegistryClient()
  const clearable = client as ClearableClient
  if (typeof clearable.clearBlob === 'function') {
    const bindings = catalogued
      ? getBlobBindings(catalogued)
      : [(await client.getModel(registryPath, registrySource))?.blobBinding].filter(
          (binding): binding is QVACBlobBinding => !!binding
        )
    for (const binding of bindings) await clearable.clearBlob(binding)
  } else {
    logger.warn('Registry client cannot clear blob blocks; deleting cached files only')
  }

  for (const target of targets) {
    await fsPromises.rm(target, { recursive: true, force: true })
  }
  logger.info(`🗑️ Deleted registry model cache: ${modelSrc}`)
}

function getCacheTargets(registryPath: string, entry: RegistryItem | undefined): string[] {
  if (entry?.shardMetadata?.length) {
    return [getShardedModelCacheDir(generateShortHash(registryPath))]
  }
  if (entry?.companionSet) return [getCompanionSetCacheDir(entry.companionSet.setKey)]
  return [getClearStorageTarget(getSingleFileCachePath(registryPath)).path]
}

function getBlobBindings(entry: RegistryItem): BlobRange[] {
  if (entry.shardMetadata?.length) return entry.shardMetadata.map(buildBlobBinding)
  if (entry.companionSet) return entry.companionSet.files.map(buildBlobBinding)
  return [buildBlobBinding(entry)]
}
