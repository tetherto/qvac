export const RESPONSES_VOLATILE_STUB = 'responses-volatile'

export interface StoredResponse {
  id: string
  createdAtSec: number
  expiresAtSec: number
  responseObject: Record<string, unknown>
  inputItems: unknown[]
  modelAlias: string
}

export interface ResponsesStoreOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => number
}

export interface ListInputItemsOptions {
  limit?: number
  after?: string | undefined
}

export interface ResponsesStore {
  put: (record: StoredResponse) => void
  get: (id: string) => StoredResponse | undefined
  delete: (id: string) => boolean
  listInputItems: (
    id: string,
    opts?: ListInputItemsOptions
  ) => {
    object: string
    data: unknown[]
    first_id: string | null
    last_id: string | null
    has_more: boolean
  } | null
  size: () => number
  bannerLine: () => string
}

const DEFAULT_MAX = 256
const DEFAULT_TTL_MS = 60 * 60 * 1000

export const RESPONSES_DEFAULT_TTL_SEC = Math.floor(DEFAULT_TTL_MS / 1000)

export function createResponsesStore(options: ResponsesStoreOptions = {}): ResponsesStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const nowMs = options.now ?? ((): number => Date.now())

  const map = new Map<string, StoredResponse>()

  function pruneExpired(): void {
    const t = nowMs() / 1000
    for (const [k, v] of map) {
      if (v.expiresAtSec <= t) map.delete(k)
    }
  }

  function bump(id: string, rec: StoredResponse): void {
    map.delete(id)
    map.set(id, rec)
  }

  return {
    put(record: StoredResponse): void {
      pruneExpired()
      bump(record.id, record)
      while (map.size > maxEntries) {
        const first = map.keys().next().value
        if (first === undefined) break
        map.delete(first)
      }
    },

    get(id: string): StoredResponse | undefined {
      pruneExpired()
      const rec = map.get(id)
      if (!rec) return undefined
      if (rec.expiresAtSec <= nowMs() / 1000) {
        map.delete(id)
        return undefined
      }
      bump(id, rec)
      return rec
    },

    delete(id: string): boolean {
      return map.delete(id)
    },

    listInputItems(
      id: string,
      opts?: ListInputItemsOptions
    ): {
      object: string
      data: unknown[]
      first_id: string | null
      last_id: string | null
      has_more: boolean
    } | null {
      pruneExpired()
      const rec = map.get(id)
      if (!rec) return null
      if (rec.expiresAtSec <= nowMs() / 1000) {
        map.delete(id)
        return null
      }
      const limit =
        typeof opts?.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 100) : 20
      const items = rec.inputItems as Array<{ id?: string }>
      let start = 0
      if (opts?.after) {
        const idx = items.findIndex((it) => {
          if (!it || typeof it !== 'object') return false
          const ito = it as Record<string, unknown>
          return ito['id'] === opts.after
        })
        start = idx >= 0 ? idx + 1 : items.length
      }
      const slice = items.slice(start, start + limit)
      const hasMore = start + slice.length < items.length
      const firstId =
        slice[0] &&
        typeof slice[0] === 'object' &&
        typeof (slice[0] as { id?: string }).id === 'string'
          ? (slice[0] as { id: string }).id
          : null
      const last = slice[slice.length - 1]
      const lastId =
        last && typeof last === 'object' && typeof (last as { id?: string }).id === 'string'
          ? (last as { id: string }).id
          : null
      return {
        object: 'list',
        data: slice,
        first_id: firstId,
        last_id: lastId,
        has_more: hasMore
      }
    },

    size(): number {
      pruneExpired()
      return map.size
    },

    bannerLine(): string {
      const ttlMin = Math.round(ttlMs / 60000)
      return `responses: in-memory only — IDs expire on restart, max ${maxEntries} entries, ${ttlMin}m TTL`
    }
  }
}
