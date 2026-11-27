import type { QVACBlobBinding } from '@qvac/registry-client'
import { promises as fsPromises } from 'bare-fs'
import { getModelByPath, models, type RegistryItem } from '@/models/registry/index'
import { registryUrlSchema } from '@/schemas/load-model'
import { acquireRegistryClient } from '@/runtime/registry-client'
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
import {
  holdsDownloadLockHere,
  partialDownloadPath,
  tryAcquireDownloadLocks,
  waitForDownloadLocksHere
} from '@/handlers/load-model/download-lock'
import { getLegacyCompanionSetPaths } from '@/handlers/load-model/registry-companion-set'
import { acceptsLegacyFlatCache } from '@/utils/cache/layout'
import {
  findLocallyCachedCoremlCompanionSet,
  getCoremlSetKey,
  getCoremlSidecarSpec
} from '@/handlers/load-model/coreml-sidecars'
import { findModelShards } from '@/handlers/load-model/registry'
import {
  findCatalogCoremlBundleSet,
  findRegistryCoremlBundleSet,
  getCoremlBundle,
  getCoremlBundleSetKey,
  readCachedCoremlBundleSet,
  type CoremlBundle
} from '@/handlers/load-model/coreml-bundle'
import {
  createRegistryCacheKey,
  hasActiveTransfer,
  withDownloadBlocked
} from '@/handlers/load-model/download-manager'
import { DeleteCacheFailedError, InvalidDeleteCacheParamsError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

// How long a deletion waits for a download this process cancelled to finish its cleanup.
const CANCELLED_DOWNLOAD_STOP_MS = 10_000

type BlobRange = Pick<QVACBlobBinding, 'coreKey' | 'blockOffset' | 'blockLength'>
type RegistryLease = Awaited<ReturnType<typeof acquireRegistryClient>>
type DeletePlan = { targets: string[]; bindings: BlobRange[]; registryPaths: string[] }

/**
 * Deletes a registry model's cached files and the corestore blocks a cancelled
 * or failed download kept for resume.
 */
export async function deleteRegistryModelCache(modelSrc: string): Promise<void> {
  const parsed = registryUrlSchema.safeParse(modelSrc)
  if (!parsed.success) throw new InvalidDeleteCacheParamsError()
  const { registryPath, registrySource } = parsed.data
  const cacheKey = createRegistryCacheKey(registryPath)
  assertNotDownloading(modelSrc, [cacheKey])

  // Downloads and loads of this path, from any source, are refused until the files are gone.
  await withDownloadBlocked([cacheKey], async () => {
    await using _lock = await lockOutOtherProcesses(modelSrc, [cacheKey])
    const entry = getModelByPath(registryPath)
    const catalogued = entry?.registrySource === registrySource ? entry : undefined
    // Checked first, as downloadModelFromRegistry does.
    const coremlBundle = getCoremlBundle(registrySource, registryPath)
    const plan = coremlBundle
      ? await planCoremlBundle(coremlBundle)
      : catalogued
        ? await planCatalogued(catalogued)
        : await planUncatalogued(registryPath, registrySource)

    // Companion files are shared: clearing one would erase another model's download.
    const sharedKeys = getModelsSharingFiles(plan.registryPaths)
      .map(createRegistryCacheKey)
      .filter((key) => key !== cacheKey)
    assertNotDownloading(modelSrc, sharedKeys)

    await withDownloadBlocked(sharedKeys, async () => {
      await using _sharedLock = await lockOutOtherProcesses(modelSrc, sharedKeys)
      assertNotLoaded(modelSrc, plan.targets)

      if (plan.bindings.length > 0) {
        await using lease = await acquireRegistryClient({ wait: 'query' })
        for (const binding of plan.bindings) await lease.client.clearBlob(binding)
      }

      assertNotLoaded(modelSrc, plan.targets)
      for (const target of plan.targets) {
        await fsPromises.rm(target, { recursive: true, force: true })
        // A paused download's partial file.
        await fsPromises.rm(partialDownloadPath(target), { force: true })
      }
    })
  })
  logger.info(`🗑️ Deleted registry model cache: ${modelSrc}`)
}

function assertNotDownloading(modelSrc: string, cacheKeys: string[]): void {
  if (cacheKeys.some(hasActiveTransfer)) {
    throw new DeleteCacheFailedError(`${modelSrc} is downloading; cancel it first`)
  }
}

// Other processes' downloads hold their locks; holding them blocks new ones mid-delete.
// A download this process cancelled keeps its lock until its cleanup ends, so wait for it.
async function lockOutOtherProcesses(
  modelSrc: string,
  cacheKeys: string[]
): Promise<AsyncDisposable> {
  const deadline = Date.now() + CANCELLED_DOWNLOAD_STOP_MS
  for (;;) {
    if (!(await waitForDownloadLocksHere(cacheKeys, deadline - Date.now()))) {
      throw new DeleteCacheFailedError(
        `A cancelled download of ${modelSrc} is still stopping; try again shortly`
      )
    }
    const lock = await tryAcquireDownloadLocks(cacheKeys)
    if (lock) return lock
    if (!holdsDownloadLockHere(cacheKeys)) {
      throw new DeleteCacheFailedError(
        `${modelSrc} is downloading in another process; try again once it finishes`
      )
    }
  }
}

// Every catalogued model whose own download writes one of these registry paths.
function getModelsSharingFiles(registryPaths: string[]): string[] {
  const paths = new Set(registryPaths)
  const sharing = new Set(registryPaths)
  for (const model of models as readonly RegistryItem[]) {
    const files = [
      model.registryPath,
      ...(model.companionSet?.files ?? []).map((f) => f.registryPath)
    ]
    if (files.some((file) => paths.has(file))) sharing.add(model.registryPath)
  }
  return [...sharing]
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
      bindings: entry.shardMetadata.map(buildBlobBinding),
      registryPaths: [entry.registryPath]
    }
  }

  if (entry.companionSet) {
    return {
      targets: [
        getCompanionSetCacheDir(entry.companionSet.setKey),
        ...getLegacyCompanionSetPaths(entry.companionSet, acceptsLegacyFlatCache(entry.addon))
      ],
      bindings: entry.companionSet.files.map(buildBlobBinding),
      registryPaths: entry.companionSet.files.map((file) => file.registryPath)
    }
  }

  const plan: DeletePlan = {
    targets: [getClearStorageTarget(getSingleFileCachePath(entry.registryPath)).path],
    bindings: [buildBlobBinding(entry)],
    registryPaths: [entry.registryPath]
  }

  const platform = getRuntimeContext().platform
  const spec = getCoremlSidecarSpec(entry.registryPath, entry.registrySource, platform)
  if (spec) {
    plan.targets.push(
      validateAndJoinPath(getModelsCacheDir(), 'sets', getCoremlSetKey(entry, spec))
    )
    const coremlSet = await findLocallyCachedCoremlCompanionSet(entry, platform)
    for (const file of coremlSet?.files ?? []) {
      if (file.registryPath === entry.registryPath) continue
      plan.bindings.push(buildBlobBinding(file))
      plan.registryPaths.push(file.registryPath)
    }
  }
  return plan
}

// Mirrors downloadCoremlBundleFromRegistry: the components sit in the bundle's
// own set directory beside the listing they were staged from. A download that
// never finished saved no listing, so the live registry names its blocks.
async function planCoremlBundle(bundle: CoremlBundle): Promise<DeletePlan> {
  const set =
    findCatalogCoremlBundleSet(bundle) ??
    (await readCachedCoremlBundleSet(bundle)) ??
    (await findLiveCoremlBundleSet(bundle))
  const files = set?.files ?? []
  return {
    targets: [validateAndJoinPath(getModelsCacheDir(), 'sets', getCoremlBundleSetKey(bundle))],
    bindings: files.filter((file) => file.blobCoreKey).map(buildBlobBinding),
    registryPaths: files.map((file) => file.registryPath)
  }
}

async function findLiveCoremlBundleSet(
  bundle: CoremlBundle
): ReturnType<typeof findRegistryCoremlBundleSet> {
  await using lease = await acquireRegistryClient({ wait: 'query' })
  return await findRegistryCoremlBundleSet(lease.client, bundle)
}

async function planUncatalogued(registryPath: string, registrySource: string): Promise<DeletePlan> {
  const filename = registryPath.split('/').pop() || registryPath
  if (detectShardedModel(filename).isSharded) {
    const shards = await findModelShards(registryPath, registrySource, undefined, 'query')
    return {
      targets: [getShardedModelCacheDir(generateShortHash(registryPath))],
      bindings: shards.flatMap((shard) => (shard.blobBinding ? [shard.blobBinding] : [])),
      registryPaths: [registryPath]
    }
  }

  let model: Awaited<ReturnType<RegistryLease['client']['getModel']>>
  {
    await using lease = await acquireRegistryClient({ wait: 'query' })
    model = await lease.client.getModel(registryPath, registrySource)
  }
  return {
    targets: [getClearStorageTarget(getSingleFileCachePath(registryPath)).path],
    bindings: model?.blobBinding ? [model.blobBinding] : [],
    registryPaths: [registryPath]
  }
}
