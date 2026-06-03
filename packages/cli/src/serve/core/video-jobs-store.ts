import { randomBytes } from 'node:crypto'

export type VideoJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

export interface VideoJobError {
  code: string
  message: string
}

/**
 * OpenAI-shaped video resource. Returned verbatim by `POST /v1/videos`,
 * `GET /v1/videos`, and `GET /v1/videos/{id}`; matches the `videoResource`
 * Zod schema. The store keeps records in this shape so no field-renaming
 * happens between persistence and the wire.
 */
export interface VideoResource {
  id: string
  object: 'video'
  model: string
  status: VideoJobStatus
  progress: number
  created_at: number
  completed_at: number | null
  expires_at: number
  prompt: string | null
  size: string
  seconds: string
  remixed_from_video_id: null
  error: VideoJobError | null
}

/**
 * Internal job record: the OpenAI resource fields plus server-side state.
 * Extra fields are stripped from any HTTP response by `videoJobResource()`.
 */
export interface VideoJob extends VideoResource {
  /** SDK requestId for `cancel(...)`. Set by `runVideoJob` once `video()` returns; null in the (tiny) window between job creation and that call. */
  requestId: string | null
  /** Ephemeral file id holding the AVI bytes (set when `status === 'completed'`). */
  aviFileId: string | null
  /** Ephemeral file id holding the lazily-transcoded MP4 (set on first MP4 fetch). */
  mp4FileId: string | null
  /** Aborts the in-flight generation when DELETE is called during `in_progress`. */
  controller: AbortController
}

/** Strip server-only fields and return the OpenAI-shaped resource view. */
export function videoJobResource (job: VideoJob): VideoResource {
  const { requestId, aviFileId, mp4FileId, controller, ...resource } = job
  void requestId; void aviFileId; void mp4FileId; void controller
  return resource
}

export type VideoEvictReason = 'max_entries'

export interface VideoJobsStoreOptions {
  /** Hard cap on stored entries. Oldest evicted first. */
  maxEntries?: number
  now?: () => number
  /** Fired when `create()` evicts an older job to stay within `maxEntries`. The route layer hooks this to abort the SDK call and drop the rendered bytes. */
  onEvict?: (job: VideoJob, reason: VideoEvictReason) => void
}

export interface ListVideoJobsOptions {
  limit?: number
  order?: 'asc' | 'desc'
  after?: string | undefined
}

export interface VideoJobsStore {
  create: (input: {
    model: string
    prompt: string | null
    size: string
    seconds: string
  }) => VideoJob
  update: (id: string, patch: Partial<Omit<VideoJob, 'id' | 'object' | 'controller'>>) => VideoJob | undefined
  get: (id: string) => VideoJob | undefined
  delete: (id: string) => boolean
  list: (opts?: ListVideoJobsOptions) => {
    data: VideoJob[]
    first_id: string | null
    last_id: string | null
    has_more: boolean
  }
  size: () => number
  bannerLine: () => string
}

// The route-level resource carries no real TTL — the rendered bytes have
// their own TTL in the ephemeral file store, and `/content` returns 410
// `video_expired` once they're gone. We surface a static far-future timestamp
// (year 9999) so the OpenAI shape remains non-null.
const EXPIRES_AT_SENTINEL = 253402300799

const DEFAULT_MAX_ENTRIES = 256

export function createVideoJobsStore (options: VideoJobsStoreOptions = {}): VideoJobsStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const nowMs = options.now ?? ((): number => Date.now())
  const onEvict = options.onEvict

  const jobs = new Map<string, VideoJob>()

  return {
    create (input): VideoJob {
      const id = `video_${randomBytes(12).toString('hex')}`
      const job: VideoJob = {
        id,
        object: 'video',
        model: input.model,
        status: 'queued',
        progress: 0,
        created_at: Math.floor(nowMs() / 1000),
        completed_at: null,
        expires_at: EXPIRES_AT_SENTINEL,
        prompt: input.prompt,
        size: input.size,
        seconds: input.seconds,
        remixed_from_video_id: null,
        error: null,
        requestId: null,
        aviFileId: null,
        mp4FileId: null,
        controller: new AbortController()
      }
      jobs.set(id, job)
      while (jobs.size > maxEntries) {
        const oldestId = jobs.keys().next().value
        if (oldestId === undefined) break
        const evicted = jobs.get(oldestId)!
        jobs.delete(oldestId)
        if (onEvict) onEvict(evicted, 'max_entries')
      }
      return job
    },

    update (id, patch): VideoJob | undefined {
      const rec = jobs.get(id)
      if (!rec) return undefined
      Object.assign(rec, patch)
      return rec
    },

    get (id): VideoJob | undefined {
      return jobs.get(id)
    },

    delete (id): boolean {
      return jobs.delete(id)
    },

    list (opts): {
      data: VideoJob[]
      first_id: string | null
      last_id: string | null
      has_more: boolean
    } {
      const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 100) : 20
      const order = opts?.order === 'asc' ? 'asc' : 'desc'
      const all = Array.from(jobs.values()).sort((a, b) => {
        return order === 'asc' ? a.created_at - b.created_at : b.created_at - a.created_at
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

    size (): number {
      return jobs.size
    },

    bannerLine (): string {
      return `videos: in-memory only — job IDs and rendered bytes are lost on restart, max ${maxEntries} entries`
    }
  }
}
