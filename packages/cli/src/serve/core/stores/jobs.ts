export type JobEvictReason = 'max_entries'

export interface JobsStoreOptions<T> {
  /** Hard cap on stored entries. Oldest (by insertion) evicted first. */
  maxEntries?: number
  /** Sort key for `list()`. */
  createdAt: (job: T) => number
  /** Fired when `add()` evicts an older job to stay within `maxEntries`. */
  onEvict?: (job: T, reason: JobEvictReason) => void
}

export interface ListJobsOptions {
  limit?: number
  order?: 'asc' | 'desc'
  after?: string | undefined
}

export interface JobsPage<T> {
  data: T[]
  first_id: string | null
  last_id: string | null
  has_more: boolean
}

export interface JobsStore<T extends { id: string }> {
  readonly maxEntries: number
  add: (job: T) => T
  update: (id: string, patch: Partial<T>) => T | undefined
  get: (id: string) => T | undefined
  delete: (id: string) => boolean
  list: (opts?: ListJobsOptions) => JobsPage<T>
  size: () => number
}

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100

export function createJobsStore<T extends { id: string }>(
  options: JobsStoreOptions<T>
): JobsStore<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const { createdAt, onEvict } = options

  const jobs = new Map<string, T>()

  return {
    maxEntries,

    add(job): T {
      jobs.set(job.id, job)
      while (jobs.size > maxEntries) {
        const oldestId = jobs.keys().next().value
        if (oldestId === undefined) break
        const evicted = jobs.get(oldestId)!
        jobs.delete(oldestId)
        if (onEvict) onEvict(evicted, 'max_entries')
      }
      return job
    },

    update(id, patch): T | undefined {
      const rec = jobs.get(id)
      if (!rec) return undefined
      Object.assign(rec, patch)
      return rec
    },

    get(id): T | undefined {
      return jobs.get(id)
    },

    delete(id): boolean {
      return jobs.delete(id)
    },

    list(opts): JobsPage<T> {
      const limit =
        typeof opts?.limit === 'number' && opts.limit > 0
          ? Math.min(opts.limit, MAX_LIST_LIMIT)
          : DEFAULT_LIST_LIMIT
      const order = opts?.order === 'asc' ? 'asc' : 'desc'
      const all = Array.from(jobs.values()).sort((a, b) => {
        return order === 'asc' ? createdAt(a) - createdAt(b) : createdAt(b) - createdAt(a)
      })
      let start = 0
      if (opts?.after) {
        const idx = all.findIndex((j) => j.id === opts.after)
        start = idx >= 0 ? idx + 1 : all.length
      }
      const slice = all.slice(start, start + limit)
      return {
        data: slice,
        first_id: slice[0]?.id ?? null,
        last_id: slice[slice.length - 1]?.id ?? null,
        has_more: start + slice.length < all.length
      }
    },

    size(): number {
      return jobs.size
    }
  }
}
