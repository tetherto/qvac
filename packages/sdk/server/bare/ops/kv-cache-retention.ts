import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { getKVCacheDir } from '@/server/utils'
import { getServerLogger } from '@/logging'

const logger = getServerLogger()

export interface AutoCacheRetentionOptions {
  activeCachePaths: string[]
  maxBytes: number
  maxIdleMs: number
  nowMs: number
}

interface AutoCacheEntry {
  cacheKey: string
  directoryPath: string
  size: number
  lastModifiedMs: number
  active: boolean
}

const AUTO_CACHE_MARKER_PREFIX = '.auto-cache-'
const AUTO_CACHE_MARKER_PATTERN = /^\.auto-cache-([a-f0-9]{16})$/

function getAutoCacheMarkerPath(cacheKey: string) {
  return path.join(getKVCacheDir(), `${AUTO_CACHE_MARKER_PREFIX}${cacheKey}`)
}

export async function markAutoCacheKey(cacheKey: string) {
  try {
    await fsPromises.writeFile(getAutoCacheMarkerPath(cacheKey), '')
  } catch (error) {
    logger.warn(
      `[kv-cache] Failed to write auto-cache retention marker. key=${cacheKey} error=${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function removeAutoCacheMarker(cacheKey: string) {
  try {
    await fsPromises.unlink(getAutoCacheMarkerPath(cacheKey))
  } catch {
    // The marker is best-effort cleanup metadata and may already be absent.
  }
}

export async function removeAutoCacheMarkerIfMissing(cacheKey: string) {
  try {
    await fsPromises.access(path.join(getKVCacheDir(), cacheKey))
  } catch {
    await removeAutoCacheMarker(cacheKey)
  }
}

export function isCachePathWithinDirectory(directoryPath: string, cachePath: string) {
  const prefix = `${directoryPath}${path.sep}`
  return cachePath === directoryPath || cachePath.startsWith(prefix)
}

async function readDirectory(directoryPath: string) {
  try {
    return await fsPromises.readdir(directoryPath)
  } catch {
    return null
  }
}

async function inspectAutoCacheEntry(
  cacheKey: string,
  activeCachePaths: string[]
): Promise<AutoCacheEntry | null> {
  const directoryPath = path.join(getKVCacheDir(), cacheKey)
  const modelDirectories = await readDirectory(directoryPath)
  if (modelDirectories === null) return null

  let size = 0
  let lastModifiedMs = 0

  for (const modelDirectory of modelDirectories) {
    const modelPath = path.join(directoryPath, modelDirectory.toString())
    const fileNames = await readDirectory(modelPath)
    if (fileNames === null) continue

    for (const fileName of fileNames) {
      try {
        const stats = await fsPromises.stat(path.join(modelPath, fileName.toString()))
        if (!stats.isFile()) continue
        size += stats.size
        lastModifiedMs = Math.max(lastModifiedMs, stats.mtime.getTime())
      } catch {
        // The cache may have moved or been rolled back while the sweep was inspecting it.
      }
    }
  }

  return {
    cacheKey,
    directoryPath,
    size,
    lastModifiedMs,
    active: activeCachePaths.some((cachePath) =>
      isCachePathWithinDirectory(directoryPath, cachePath)
    )
  }
}

export async function planAutoCacheEvictions(options: AutoCacheRetentionOptions) {
  const rootEntries = await readDirectory(getKVCacheDir())
  if (rootEntries === null) return []

  const entries: AutoCacheEntry[] = []
  for (const rootEntry of rootEntries) {
    const markerMatch = AUTO_CACHE_MARKER_PATTERN.exec(rootEntry.toString())
    if (markerMatch === null) continue
    const cacheKey = markerMatch[1]
    if (cacheKey === undefined) continue
    const entry = await inspectAutoCacheEntry(cacheKey, options.activeCachePaths)
    if (entry === null) {
      await removeAutoCacheMarker(cacheKey)
      continue
    }
    entries.push(entry)
  }

  let retainedBytes = entries.reduce((total, entry) => total + entry.size, 0)
  const evictions = new Set<string>()

  for (const entry of entries) {
    if (entry.active) continue
    const expired =
      entry.lastModifiedMs === 0 ||
      (options.maxIdleMs > 0 && options.nowMs - entry.lastModifiedMs > options.maxIdleMs)
    if (!expired) continue
    evictions.add(entry.cacheKey)
    retainedBytes -= entry.size
  }

  const oldestFirst = entries
    .filter((entry) => !entry.active && !evictions.has(entry.cacheKey))
    .sort((a, b) => a.lastModifiedMs - b.lastModifiedMs)

  for (const entry of oldestFirst) {
    if (retainedBytes <= options.maxBytes) break
    evictions.add(entry.cacheKey)
    retainedBytes -= entry.size
  }

  return Array.from(evictions)
}
