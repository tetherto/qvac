import crypto from 'bare-crypto'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import {
  type CacheMessage,
  getAutoCacheLookupHistory,
  getKVCacheDir,
  validateAndJoinPath
} from '@/utils/index'
import { getEngineLogger } from '@/logging/index'
import { Buffer } from 'bare-buffer'
import { markAutoCacheKey } from '@/plugins/ops/kv-cache-retention'

const logger = getEngineLogger()

// In-memory KV-cache state lives in `KvCacheSession` (the single
// mutation point for all three KV-cache bookkeeping layers). This
// module keeps only the pure path / hash utilities that don't touch
// in-memory state.

export function extractSystemPrompt(messages: CacheMessage[]): string | null {
  const systemMessage = messages.find((msg) => msg.role === 'system')
  return systemMessage ? systemMessage.content : null
}

// Cache hash based on the system prompt + complete tool definitions.
// Callers pass tools only when the tool block is written into the cache and
// left there, so a different tool set gets its own cache instead of reusing a
// prefix that holds the old block. Every prompt-affecting field participates,
// not just the name: canonical serialization avoids cache misses caused only
// by object-key insertion order, while tool-array order is preserved because
// that is the order sent to the model.
function canonicalizeHashInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeHashInput)
  if (typeof value !== 'object' || value === null) return value

  const canonical: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalizeHashInput((value as Record<string, unknown>)[key])
  }
  return canonical
}

export function generateConfigHash(systemPrompt: string | null, tools?: unknown): string {
  const hash = crypto.createHash('sha-256')
  const canonicalConfig = JSON.stringify(
    canonicalizeHashInput({ systemPrompt, tools: Array.isArray(tools) ? tools : [] })
  )
  hash.update(Buffer.from(canonicalConfig, 'utf8'))
  return hash.digest('hex').substring(0, 16)
}

export function generateCacheKey(messages: CacheMessage[]): string {
  const hash = crypto.createHash('sha-256')
  const historyString = JSON.stringify(messages)
  const historyBuffer = Buffer.from(historyString, 'utf8')
  hash.update(historyBuffer)
  const hashString = hash.digest('hex')
  return hashString.substring(0, 16)
}

function resolveCacheFilePath(modelId: string, configHash: string, cacheKey: string): string {
  const cacheDir = getKVCacheDir()
  const sessionCacheDir = validateAndJoinPath(cacheDir, cacheKey)
  const modelCacheDir = validateAndJoinPath(sessionCacheDir, modelId)
  return path.join(modelCacheDir, `${configHash}.bin`)
}

export async function getCacheFilePath(
  modelId: string,
  configHash: string,
  cacheKey: string
): Promise<string> {
  const cachePath = resolveCacheFilePath(modelId, configHash, cacheKey)
  const modelCacheDir = path.dirname(cachePath)

  try {
    await fsPromises.mkdir(modelCacheDir, { recursive: true })
  } catch {
    // Ignore if directories already exist
  }

  return cachePath
}

// Used for auto-generated cache key
export async function findMatchingCache(
  modelId: string,
  configHash: string,
  currentHistory: CacheMessage[]
): Promise<{ cacheKey: string; cachePath: string } | null> {
  if (currentHistory.length <= 1) {
    return null
  }

  const previousHistory = getAutoCacheLookupHistory(currentHistory)
  const cacheKey = generateCacheKey(previousHistory)
  const cachePath = resolveCacheFilePath(modelId, configHash, cacheKey)

  try {
    await fsPromises.access(cachePath)
    await markAutoCacheKey(cacheKey)
    return { cacheKey, cachePath }
  } catch {
    return null
  }
}

export async function getCurrentCacheInfo(
  modelId: string,
  configHash: string,
  currentHistory: CacheMessage[]
): Promise<{
  cacheKey: string
  cachePath: string
}> {
  const cacheKey = generateCacheKey(currentHistory)
  await markAutoCacheKey(cacheKey)
  const cachePath = await getCacheFilePath(modelId, configHash, cacheKey)
  return { cacheKey, cachePath }
}

export async function renameCacheFile(oldPath: string, newPath: string): Promise<boolean> {
  try {
    await fsPromises.rename(oldPath, newPath)
    return true
  } catch (error) {
    logger.error(
      'Error renaming cache file:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

export async function pruneEmptyCacheDirectories(cacheFilePath: string): Promise<void> {
  const cacheDir = getKVCacheDir()
  const cacheDirPrefix = `${cacheDir}${path.sep}`
  let currentDirectory = path.dirname(cacheFilePath)

  while (currentDirectory.startsWith(cacheDirPrefix)) {
    try {
      await fsPromises.rmdir(currentDirectory)
    } catch {
      return
    }
    currentDirectory = path.dirname(currentDirectory)
  }
}

// Cache-existence probing (in-memory registry first, fall back to
// `fs.access`) lives in `KvCacheSession.beginTurn(...)`. Keeping the
// in-memory `initializedCaches` set private to the session module
// avoids drift between the two layers.

export async function deleteCache(
  options: { all: true } | { kvCacheKey: string; modelId?: string }
): Promise<string> {
  const cacheDir = getKVCacheDir()

  if ('all' in options) {
    await fsPromises.rm(cacheDir, { recursive: true, force: true })
    await fsPromises.mkdir(cacheDir, { recursive: true })
    return cacheDir
  }

  const kvCacheDir = validateAndJoinPath(cacheDir, options.kvCacheKey)
  const targetDir =
    options.modelId !== undefined ? validateAndJoinPath(kvCacheDir, options.modelId) : kvCacheDir

  await fsPromises.rm(targetDir, { recursive: true, force: true })
  return targetDir
}
