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
import { PathTraversalError } from '@/errors/index'
import { Buffer } from 'bare-buffer'
import { markAutoCacheKey } from '@/plugins/ops/kv-cache-retention'

const logger = getEngineLogger()

// In-memory KV-cache state lives in `KvCacheSession`, its single mutation
// point. This module keeps only the pure path / hash utilities that don't
// touch in-memory state.

export function extractSystemPrompt(messages: CacheMessage[]): string | null {
  const systemMessage = messages.find((msg) => msg.role === 'system')
  return systemMessage ? systemMessage.content : null
}

// Names the cache file by system prompt only. Tools stay out on purpose: the
// addon compares the rendered prompt against the tokens the file holds, so a
// changed tool set on the same key must reach the same file to be trimmed there.
// The empty `tools` keeps the path earlier releases gave a tool-less cache, so
// an upgrade overwrites those files instead of orphaning them.
export function generateConfigHash(systemPrompt: string | null): string {
  const hash = crypto.createHash('sha-256')
  hash.update(Buffer.from(JSON.stringify({ systemPrompt, tools: [] }), 'utf8'))
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

export async function pruneEmptyCacheDirectories(
  cacheFilePath: string,
  activePaths: readonly string[] = []
): Promise<void> {
  const cacheDir = getKVCacheDir()
  const cacheDirPrefix = `${cacheDir}${path.sep}`
  let currentDirectory = path.dirname(cacheFilePath)

  while (currentDirectory.startsWith(cacheDirPrefix)) {
    // Keep a directory another in-flight turn still holds (its .bin isn't on disk yet).
    const childPrefix = `${currentDirectory}${path.sep}`
    if (activePaths.some((p) => p.startsWith(childPrefix))) return
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

  // validateAndJoinPath sanitizes the key (strips traversal) and rejects
  // escapes, so nested and other in-root keys resolve normally. A key that
  // resolves to the cache root would wipe every cache — reject it BEFORE joining
  // any modelId, so an empty key plus a modelId can't delete a real key dir
  // under the root.
  const cacheRoot = path.resolve(cacheDir)
  const kvCacheDir = validateAndJoinPath(cacheDir, options.kvCacheKey)
  if (path.resolve(kvCacheDir) === cacheRoot) {
    throw new PathTraversalError(options.kvCacheKey, cacheDir)
  }
  // Omitting modelId means "delete every model under the key"; a PROVIDED but
  // empty/dot modelId collapses back to that same dir and would silently broaden
  // the delete — reject it.
  const targetDir =
    options.modelId !== undefined ? validateAndJoinPath(kvCacheDir, options.modelId) : kvCacheDir
  if (options.modelId !== undefined && path.resolve(targetDir) === path.resolve(kvCacheDir)) {
    throw new PathTraversalError(options.modelId, kvCacheDir)
  }

  await fsPromises.rm(targetDir, { recursive: true, force: true })
  return targetDir
}
