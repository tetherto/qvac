import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deleteCache } from '@qvac/sdk'

/** Every Responses cache key starts with this, so retention can tell them apart. */
export const RESPONSES_KV_CACHE_PREFIX = 'responses-'

const GiB = 1024 ** 3
const HOUR_MS = 60 * 60 * 1000

interface Logger {
  info: (message: string) => void
}

export interface NamedKvCacheRetentionOptions {
  prefix: string
  /** The SDK's KV cache directory, which holds one folder per cache key. */
  dir?: string
  maxBytes?: number
  idleTtlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  deleteKey?: (key: string) => Promise<void>
}

export interface NamedKvCacheRetention {
  /** Marks a key in use until the returned release runs; in-use keys are never swept. */
  acquire: (key: string) => () => void
  /** Deletes idle and over-quota caches, or with `all`, every cache not in use. */
  sweep: (opts?: { all?: boolean }) => Promise<number>
  /** Starts a sweep unless one ran within the sweep interval. */
  maybeSweep: (logger?: Logger) => void
}

interface CacheEntry {
  key: string
  bytes: number
  lastUsedMs: number
}

// Named caches sit outside the SDK's automatic retention, so a server that
// names one per conversation would grow the cache directory without bound.
// This applies the same policy to the caches it names: a 24-hour idle TTL and
// a 4 GiB least-recently-used quota, swept at most every five minutes.
export function createNamedKvCacheRetention(
  opts: NamedKvCacheRetentionOptions
): NamedKvCacheRetention {
  const dir = opts.dir ?? join(homedir(), '.qvac', 'kv-cache')
  const maxBytes = opts.maxBytes ?? 4 * GiB
  const idleTtlMs = opts.idleTtlMs ?? 24 * HOUR_MS
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60 * 1000
  const now = opts.now ?? Date.now
  const deleteKey =
    opts.deleteKey ?? ((kvCacheKey: string) => deleteCache({ kvCacheKey }).then(() => undefined))
  const inUse = new Map<string, number>()
  let lastSweepMs = Number.NEGATIVE_INFINITY
  let sweeping: Promise<number> | undefined

  function acquire(key: string): () => void {
    inUse.set(key, (inUse.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (inUse.get(key) ?? 1) - 1
      if (count > 0) inUse.set(key, count)
      else inUse.delete(key)
    }
  }

  async function entries(): Promise<CacheEntry[]> {
    let dirents: Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: CacheEntry[] = []
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !dirent.name.startsWith(opts.prefix)) continue
      const usage = await folderUsage(join(dir, dirent.name))
      out.push({ key: dirent.name, ...usage })
    }
    return out
  }

  async function sweep({ all = false }: { all?: boolean } = {}): Promise<number> {
    const caches = await entries()
    let total = caches.reduce((sum, entry) => sum + entry.bytes, 0)
    const idle = caches
      .filter((entry) => !inUse.has(entry.key))
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
    let deleted = 0
    for (const entry of idle) {
      const expired = now() - entry.lastUsedMs > idleTtlMs
      if (!all && !expired && total <= maxBytes) continue
      await deleteKey(entry.key)
      total -= entry.bytes
      deleted++
    }
    return deleted
  }

  function maybeSweep(logger?: Logger): void {
    if (sweeping || now() - lastSweepMs < sweepIntervalMs) return
    lastSweepMs = now()
    sweeping = sweep()
      .then((deleted) => {
        if (deleted > 0) logger?.info(`  kv-cache swept ${deleted} idle Responses cache(s)`)
        return deleted
      })
      .catch((err: unknown) => {
        logger?.info(`  kv-cache sweep failed: ${err instanceof Error ? err.message : String(err)}`)
        return 0
      })
      .finally(() => {
        sweeping = undefined
      })
  }

  return { acquire, sweep, maybeSweep }
}

async function folderUsage(path: string): Promise<{ bytes: number; lastUsedMs: number }> {
  let bytes = 0
  let lastUsedMs = 0
  for (const dirent of await readdir(path, { withFileTypes: true })) {
    const child = join(path, dirent.name)
    if (dirent.isDirectory()) {
      const usage = await folderUsage(child)
      bytes += usage.bytes
      lastUsedMs = Math.max(lastUsedMs, usage.lastUsedMs)
    } else if (dirent.isFile()) {
      const info = await stat(child)
      bytes += info.size
      lastUsedMs = Math.max(lastUsedMs, info.mtimeMs)
    }
  }
  return { bytes, lastUsedMs }
}

export const responsesKvCacheRetention = createNamedKvCacheRetention({
  prefix: RESPONSES_KV_CACHE_PREFIX
})
