import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getQvacPath } from '@/utils/qvac-paths'
import { validateAndJoinPath } from '@/utils/path-security'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

const KV_CACHE_POLICY_DEFAULTS: Readonly<Record<string, unknown>> = {
  cache_share_across_keys: false
}

const KV_CACHE_RUNTIME_ONLY_KEYS: ReadonlySet<string> = new Set([
  'openclCacheDir',
  'verbosity',
  'cache_ram_mib'
])

const KV_CACHE_DIR_IDS_DIR = 'kv-cache-dir-ids'

const kvCacheDirIds = new Map<string, string>()

export function kvCacheIdentityConfig(
  config: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!config) return config
  const identity: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (KV_CACHE_RUNTIME_ONLY_KEYS.has(key)) continue
    identity[key] = Object.hasOwn(KV_CACHE_POLICY_DEFAULTS, key)
      ? KV_CACHE_POLICY_DEFAULTS[key]
      : value
  }
  return identity
}

function persistedKvCacheDirIdPath(modelId: string): string {
  return validateAndJoinPath(getQvacPath(KV_CACHE_DIR_IDS_DIR), modelId)
}

export async function recordKvCacheDirId(modelId: string, cacheDirId: string): Promise<void> {
  kvCacheDirIds.set(modelId, cacheDirId)
  if (cacheDirId === modelId) return
  const filePath = persistedKvCacheDirIdPath(modelId)
  try {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
    await fsPromises.writeFile(filePath, cacheDirId)
  } catch (error) {
    logger.warn(
      `Could not record the KV cache folder of model ${modelId}; deleteCache by this model id in a later process will miss it:`,
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function kvCacheDirIdFor(modelId: string): string {
  return kvCacheDirIds.get(modelId) ?? modelId
}

export async function resolveKvCacheDirId(modelId: string): Promise<string> {
  const known = kvCacheDirIds.get(modelId)
  if (known !== undefined) return known
  try {
    const persisted = (await fsPromises.readFile(persistedKvCacheDirIdPath(modelId))).toString()
    return persisted || modelId
  } catch {
    return modelId
  }
}

export const __kvCacheDirIdTestHooks = {
  forgetInMemory(): void {
    kvCacheDirIds.clear()
  }
}
