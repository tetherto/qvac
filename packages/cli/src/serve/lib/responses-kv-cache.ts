import { unlinkSync, type Dirent } from 'node:fs'
import { mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
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
  /** Every key this server generates: `<prefix>` then a 64-hex SHA-256 digest. */
  prefix: string
  /** The SDK's KV cache directory, which holds one folder per cache key. */
  dir?: string
  maxBytes?: number
  idleTtlMs?: number
  sweepIntervalMs?: number
  now?: () => number
  deleteKey?: (key: string) => Promise<void>
  /** This process, as named in lease files; overridable for tests. */
  pid?: number
  isAlive?: (pid: number) => boolean
  /** A lease or sweep file not refreshed for this long belongs to a dead holder. */
  leaseStaleMs?: number
}

export interface NamedKvCacheRetention {
  /** Keys this server has used and still tracks; exposed for tests. */
  ownedKeys: () => ReadonlySet<string>
  /**
   * Marks a key in use until the returned release runs; in-use keys are never
   * swept. Waits first if that key is being deleted.
   */
  acquire: (key: string) => Promise<() => void>
  /**
   * Deletes caches idle past the TTL, then this server's own caches over the
   * quota, or with `all`, every cache of its own that is not in use.
   */
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
//
// Other QVAC processes can share the cache directory. A request leaves a
// lease file (named by its pid) while it uses a key, and a sweep claims a key
// with a marker before deleting it. Each side writes its own file before
// checking for the other's, so a sweep never deletes a key a live process
// holds, and a request waits out a deletion in progress. A holder refreshes
// its file's timestamp while it holds it, so a file counts as live only if its
// process exists and it was refreshed recently: a crashed holder's file goes
// stale even when the OS reuses its pid. Stale files are removed. The quota and `all` also only delete
// keys this server has used; the idle TTL applies to every key.
export function createNamedKvCacheRetention(
  opts: NamedKvCacheRetentionOptions
): NamedKvCacheRetention {
  // The same home the Node SDK gives its worker: Snap's HOME can be revision-scoped.
  const dir = opts.dir ?? join(process.env['SNAP_USER_COMMON'] || homedir(), '.qvac', 'kv-cache')
  const maxBytes = opts.maxBytes ?? 4 * GiB
  const idleTtlMs = opts.idleTtlMs ?? 24 * HOUR_MS
  const sweepIntervalMs = opts.sweepIntervalMs ?? 5 * 60 * 1000
  const now = opts.now ?? Date.now
  const deleteKey =
    opts.deleteKey ?? ((kvCacheKey: string) => deleteCache({ kvCacheKey }).then(() => undefined))
  const pid = opts.pid ?? process.pid
  const isAlive = opts.isAlive ?? processAlive
  const leases = join(dir, '.responses-leases')
  const leaseStaleMs = opts.leaseStaleMs ?? 2 * 60 * 1000
  let leaseSeq = 0
  const keyShape = new RegExp(`^${opts.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{64}$`)
  const inUse = new Map<string, number>()
  const owned = new Set<string>()
  const deleting = new Map<string, Promise<void>>()
  let lastSweepMs = Number.NEGATIVE_INFINITY
  let sweeping: Promise<number> | undefined
  // Sweeps run one at a time: two overlapping ones could delete the same key,
  // and the first to finish would clear its deletion while the other still runs.
  let queue: Promise<unknown> = Promise.resolve()

  // `<key>.lease-<pid>-<n>` / `<key>.sweep-<pid>` files whose process is
  // alive; a dead process's file is removed on the way. Kept flat in one
  // directory so nothing ever removes a folder another process is writing into.
  async function liveFiles(key: string, kind: 'lease' | 'sweep'): Promise<string[]> {
    const prefix = `${key}.${kind}-`
    const names = (await gone(() => readdir(leases))) ?? []
    const live: string[] = []
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const owner = Number(name.slice(prefix.length).split('-')[0])
      const info = await gone(() => stat(join(leases, name)))
      if (!info) continue
      if (isAlive(owner) && now() - info.mtimeMs <= leaseStaleMs) live.push(name)
      else await unlink(join(leases, name)).catch(() => undefined)
    }
    return live
  }

  async function acquire(key: string): Promise<() => void> {
    while (deleting.has(key)) await deleting.get(key)!.catch(() => undefined)
    inUse.set(key, (inUse.get(key) ?? 0) + 1)
    owned.add(key)
    const lease = join(leases, `${key}.lease-${pid}-${leaseSeq++}`)
    let stopRefresh: (() => void) | undefined
    const release = (): void => {
      stopRefresh?.()
      try {
        unlinkSync(lease)
      } catch {
        // Never written, or already gone with the whole cache directory.
      }
      const count = (inUse.get(key) ?? 1) - 1
      if (count > 0) inUse.set(key, count)
      else inUse.delete(key)
    }
    try {
      await mkdir(leases, { recursive: true })
      await writeFile(lease, '')
      stopRefresh = keepFresh(lease)
      // Another process may be deleting this key; wait until it has finished.
      while ((await liveFiles(key, 'sweep')).length > 0) await delay(50)
    } catch (err) {
      release()
      throw err
    }
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  // Refreshes a held file's timestamp so other processes see it as live.
  function keepFresh(file: string): () => void {
    const timer = setInterval(() => {
      const at = new Date()
      utimes(file, at, at).catch(() => undefined)
    }, leaseStaleMs / 4)
    timer.unref()
    return () => clearInterval(timer)
  }

  // Marks the key as being deleted by this process. Null when a live process
  // holds a lease on it or another process is already sweeping it.
  async function claim(key: string): Promise<(() => Promise<void>) | null> {
    const marker = join(leases, `${key}.sweep-${pid}`)
    await mkdir(leases, { recursive: true })
    try {
      await writeFile(marker, '', { flag: 'wx' })
    } catch {
      return null
    }
    const stopRefresh = keepFresh(marker)
    const done = async (): Promise<void> => {
      stopRefresh()
      await unlink(marker).catch(() => undefined)
    }
    try {
      const sweepers = await liveFiles(key, 'sweep')
      const holders = await liveFiles(key, 'lease')
      if (sweepers.length > 1 || holders.length > 0) {
        await done()
        return null
      }
    } catch (err) {
      await done()
      throw err
    }
    return done
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
      if (!dirent.isDirectory() || !keyShape.test(dirent.name)) continue
      const usage = await folderUsage(join(dir, dirent.name))
      if (usage) out.push({ key: dirent.name, ...usage })
    }
    return out
  }

  function sweep(opts: { all?: boolean } = {}): Promise<number> {
    const run = queue.then(() => sweepNow(opts))
    queue = run.catch(() => undefined)
    return run
  }

  async function sweepNow({ all = false }: { all?: boolean }): Promise<number> {
    const caches = await entries()
    // A failed or cancelled first turn can leave no folder behind; forget it.
    // The listing above is a snapshot, so a folder created since is re-checked.
    const present = new Set(caches.map((entry) => entry.key))
    for (const key of [...owned]) {
      if (present.has(key) || inUse.has(key)) continue
      const exists = await gone(() => stat(join(dir, key)))
      if (!exists && !inUse.has(key)) owned.delete(key)
    }
    // The quota covers only this server's caches, the ones it can evict: other
    // processes' caches would otherwise keep it over the limit and evict ours.
    let total = caches.reduce((sum, entry) => (owned.has(entry.key) ? sum + entry.bytes : sum), 0)
    const idle = caches
      .filter((entry) => !inUse.has(entry.key))
      .sort((a, b) => a.lastUsedMs - b.lastUsedMs)
    let deleted = 0
    for (const entry of idle) {
      if (!all && total <= maxBytes && now() - entry.lastUsedMs <= idleTtlMs) continue
      // A request may have taken or refreshed the key while an earlier deletion
      // awaited, so decide on what the cache looks like now.
      if (inUse.has(entry.key)) continue
      const current = await folderUsage(join(dir, entry.key))
      const mine = owned.has(entry.key)
      if (!current) {
        if (mine) total -= entry.bytes
        continue
      }
      if (mine) total += current.bytes - entry.bytes
      const expired = now() - current.lastUsedMs > idleTtlMs
      const evictable = mine && (all || total > maxBytes)
      if (!expired && !evictable) continue
      if (inUse.has(entry.key)) continue
      const release = await claim(entry.key)
      if (!release) continue
      const deletion = deleteKey(entry.key)
      deleting.set(entry.key, deletion)
      try {
        await deletion
      } finally {
        deleting.delete(entry.key)
        await release()
      }
      if (mine) total -= current.bytes
      owned.delete(entry.key)
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

  return { acquire, sweep, maybeSweep, ownedKeys: () => owned }
}

// A cache can be removed while it is scanned (a cancelled turn, another
// cleanup); what disappeared is skipped rather than failing the whole sweep.
export async function folderUsage(
  path: string
): Promise<{ bytes: number; lastUsedMs: number } | null> {
  const dirents = await gone(() => readdir(path, { withFileTypes: true }))
  if (!dirents) return null
  let bytes = 0
  let lastUsedMs = 0
  for (const dirent of dirents) {
    const child = join(path, dirent.name)
    if (dirent.isDirectory()) {
      const usage = await folderUsage(child)
      if (!usage) continue
      bytes += usage.bytes
      lastUsedMs = Math.max(lastUsedMs, usage.lastUsedMs)
    } else if (dirent.isFile()) {
      const info = await gone(() => stat(child))
      if (!info) continue
      bytes += info.size
      lastUsedMs = Math.max(lastUsedMs, info.mtimeMs)
    }
  }
  return { bytes, lastUsedMs }
}

async function gone<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export const responsesKvCacheRetention = createNamedKvCacheRetention({
  prefix: RESPONSES_KV_CACHE_PREFIX
})

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
