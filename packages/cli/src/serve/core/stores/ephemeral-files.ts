import { randomBytes } from 'node:crypto'

export interface EphemeralFileRecord {
  data: Buffer
  fileName: string
  purpose: string
  /** MIME type for `GET /v1/files/{id}/content`. Defaults to `application/octet-stream`. */
  contentType: string
  createdAtMs: number
  /** Wall-clock ms at which this record becomes eligible for eviction; null when TTL is disabled. */
  expiresAtMs: number | null
}

export type EphemeralFileEvictReason = 'ttl' | 'max_files' | 'max_bytes'

export interface EphemeralFilesStoreOptions {
  /** Hard cap on total bytes across the store; oldest records evicted first when exceeded. */
  maxBytes?: number
  /** Hard cap on number of records. */
  maxFiles?: number
  /** Records older than this (ms) are evicted on every put. */
  ttlMs?: number
  /** Optional callback fired for each evicted record (lets operators surface eviction in logs). */
  onEvict?: (id: string, reason: EphemeralFileEvictReason) => void
}

export interface EphemeralFilesStore {
  /** Store bytes and return an OpenAI-shaped `file-…` id. */
  put: (
    record: Omit<EphemeralFileRecord, 'createdAtMs' | 'expiresAtMs' | 'contentType'> & {
      contentType?: string
    }
  ) => string
  /** Return the record if present; does not remove. */
  get: (id: string) => EphemeralFileRecord | null
  /** Return all current records (newest first), without their bytes. */
  list: () => Array<{ id: string; record: EphemeralFileRecord }>
  /** Remove a file by id if present. */
  remove: (id: string) => void
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILES = 256
const DEFAULT_TTL_MS = 60 * 60 * 1000

export function createEphemeralFilesStore(
  nowMs: () => number = () => Date.now(),
  options: EphemeralFilesStoreOptions = {}
): EphemeralFilesStore {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const onEvict = options.onEvict

  const map = new Map<string, EphemeralFileRecord>()

  function totalBytes(): number {
    let n = 0
    for (const rec of map.values()) n += rec.data.length
    return n
  }

  function evict(id: string, reason: EphemeralFileEvictReason): void {
    if (!map.delete(id)) return
    if (onEvict) onEvict(id, reason)
  }

  function evictExpired(now: number): void {
    if (ttlMs <= 0) return
    for (const [id, rec] of map.entries()) {
      if (now - rec.createdAtMs > ttlMs) evict(id, 'ttl')
    }
  }

  function evictOldestUntil(predicate: () => boolean, reason: EphemeralFileEvictReason): void {
    if (predicate()) return
    const ids = Array.from(map.entries())
      .sort((a, b) => a[1].createdAtMs - b[1].createdAtMs)
      .map(([id]) => id)
    for (const id of ids) {
      if (predicate()) return
      evict(id, reason)
    }
  }

  return {
    put(record) {
      const now = nowMs()
      evictExpired(now)
      const id = `file-${randomBytes(12).toString('hex')}`
      map.set(id, {
        data: record.data,
        fileName: record.fileName,
        purpose: record.purpose,
        contentType: record.contentType ?? 'application/octet-stream',
        createdAtMs: now,
        expiresAtMs: ttlMs > 0 ? now + ttlMs : null
      })
      evictOldestUntil(() => map.size <= maxFiles, 'max_files')
      evictOldestUntil(() => totalBytes() <= maxBytes, 'max_bytes')
      return id
    },
    get(id) {
      const rec = map.get(id)
      if (!rec) return null
      if (rec.expiresAtMs !== null && nowMs() > rec.expiresAtMs) {
        evict(id, 'ttl')
        return null
      }
      return rec
    },
    list() {
      return Array.from(map.entries())
        .map(([id, record]) => ({ id, record }))
        .sort((a, b) => b.record.createdAtMs - a.record.createdAtMs)
    },
    remove(id) {
      map.delete(id)
    }
  }
}
