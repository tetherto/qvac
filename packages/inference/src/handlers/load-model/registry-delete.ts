import type { QVACBlobBinding } from '@qvac/registry-client'
import { promises as fsPromises } from 'bare-fs'
import { getModelByPath, type RegistryItem } from '@/models/registry/index'
import { registryUrlSchema } from '@/schemas/load-model'
import { getRegistryClient } from '@/runtime/registry-client'
import { getAllModelIds, getModelEntry } from '@/runtime/model-registry'
import { getRuntimeContext } from '@/runtime/state'
import { detectShardedModel, generateShortHash } from '@/utils/index'
import { validateAndJoinPath } from '@/utils/path-security'
import {
  getClearStorageTarget,
  getCompanionSetCacheDir,
  getModelsCacheDir,
  getShardedModelCacheDir,
  getSingleFileCachePath
} from '@/utils/cache/paths'
import { buildBlobBinding } from '@/handlers/load-model/registry-download-utils'
import { getLegacyCompanionSetPaths } from '@/handlers/load-model/registry-companion-set'
import {
  findLocallyCachedCoremlCompanionSet,
  getCoremlSetKey,
  getCoremlSidecarSpec
} from '@/handlers/load-model/coreml-sidecars'
import { findModelShards } from '@/handlers/load-model/registry'
import {
  createRegistryCacheKey,
  hasActiveTransfer,
  withDownloadBlocked
} from '@/handlers/load-model/download-manager'
import { DeleteCacheFailedError, InvalidDeleteCacheParamsError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

type BlobRange = Pick<QVACBlobBinding, 'coreKey' | 'blockOffset' | 'blockLength'>
type ClearableClient = { clearBlob?: (binding: BlobRange) => Promise<void> }
type RegistryClient = Awaited<ReturnType<typeof getRegistryClient>>
type DeletePlan = { targets: string[]; bindings: BlobRange[] }

/**
 * Deletes a registry model's cached files and the corestore blocks a cancelled
 * or failed download kept for resume.
 */
export async function deleteRegistryModelCache(modelSrc: string): Promise<void> {
  const parsed = registryUrlSchema.safeParse(modelSrc)
  if (!parsed.success) throw new InvalidDeleteCacheParamsError()
  const { registryPath, registrySource } = parsed.data
  const cacheKey = createRegistryCacheKey(registryPath)

  if (hasActiveTransfer(cacheKey)) {
    throw new DeleteCacheFailedError(`${modelSrc} is downloading; cancel it first`)
  }

  // Downloads and loads of this path, from any source, are refused until the files are gone.
  await withDownloadBlocked(cacheKey, async () => {
    const client = await getRegistryClient()
    const entry = getModelByPath(registryPath)
    const catalogued = entry?.registrySource === registrySource ? entry : undefined
    const plan = catalogued
      ? await planCatalogued(catalogued)
      : await planUncatalogued(client, registryPath, registrySource)

    assertNotLoaded(modelSrc, plan.targets)

    // Read structurally: older registry clients have no clearBlob.
    const clearable = client as ClearableClient
    if (typeof clearable.clearBlob === 'function') {
      for (const binding of plan.bindings) await clearable.clearBlob(binding)
    } else {
      logger.warn('Registry client cannot clear blob blocks; deleting cached files only')
    }

    assertNotLoaded(modelSrc, plan.targets)
    for (const target of plan.targets) {
      await fsPromises.rm(target, { recursive: true, force: true })
    }
  })
  logger.info(`🗑️ Deleted registry model cache: ${modelSrc}`)
}

function assertNotLoaded(modelSrc: string, targets: string[]): void {
  for (const id of getAllModelIds()) {
    const loadedPath = getModelEntry(id)?.local.path
    if (loadedPath && targets.some((target) => loadedPath.startsWith(target))) {
      throw new DeleteCacheFailedError(`${modelSrc} is loaded; unload it with clearStorage instead`)
    }
  }
}

// Mirrors the layouts downloadModelFromRegistry reads, including legacy ones.
async function planCatalogued(entry: RegistryItem): Promise<DeletePlan> {
  if (entry.shardMetadata?.length) {
    return {
      targets: [getShardedModelCacheDir(generateShortHash(entry.registryPath))],
      bindings: entry.shardMetadata.map(buildBlobBinding)
    }
  }

  if (entry.companionSet) {
    return {
      targets: [
        getCompanionSetCacheDir(entry.companionSet.setKey),
        ...getLegacyCompanionSetPaths(entry.companionSet, entry.addon === 'nmt')
      ],
      bindings: entry.companionSet.files.map(buildBlobBinding)
    }
  }

  const plan: DeletePlan = {
    targets: [getClearStorageTarget(getSingleFileCachePath(entry.registryPath)).path],
    bindings: [buildBlobBinding(entry)]
  }

  const platform = getRuntimeContext().platform
  const spec = getCoremlSidecarSpec(entry.registryPath, entry.registrySource, platform)
  if (spec) {
    plan.targets.push(
      validateAndJoinPath(getModelsCacheDir(), 'sets', getCoremlSetKey(entry, spec))
    )
    const coremlSet = await findLocallyCachedCoremlCompanionSet(entry, platform)
    for (const file of coremlSet?.files ?? []) {
      if (file.registryPath !== entry.registryPath) plan.bindings.push(buildBlobBinding(file))
    }
  }
  return plan
}

async function planUncatalogued(
  client: RegistryClient,
  registryPath: string,
  registrySource: string
): Promise<DeletePlan> {
  const filename = registryPath.split('/').pop() || registryPath
  if (detectShardedModel(filename).isSharded) {
    // The lookup matches by prefix, so it can return other models' shards.
    const family = shardFamily(registryPath)
    const shards = (await findModelShards(registryPath)).filter(
      (shard) => shard.source === registrySource && shardFamily(shard.path) === family
    )
    return {
      targets: [getShardedModelCacheDir(generateShortHash(registryPath))],
      bindings: shards.flatMap((shard) => (shard.blobBinding ? [shard.blobBinding] : []))
    }
  }

  const model = await client.getModel(registryPath, registrySource)
  return {
    targets: [getClearStorageTarget(getSingleFileCachePath(registryPath)).path],
    bindings: model?.blobBinding ? [model.blobBinding] : []
  }
}

function shardFamily(registryPath: string): string {
  return registryPath.replace(/-\d{5}-of-\d{5}\./, '.')
}
