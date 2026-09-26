import { randomBytes } from 'node:crypto'
import {
  createJobsStore,
  type JobEvictReason,
  type JobsPage,
  type ListJobsOptions
} from '@/serve/core/stores/jobs'

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
export function videoJobResource(job: VideoJob): VideoResource {
  const { requestId, aviFileId, mp4FileId, controller, ...resource } = job
  void requestId
  void aviFileId
  void mp4FileId
  void controller
  return resource
}

export type VideoEvictReason = JobEvictReason

export interface VideoJobsStoreOptions {
  /** Hard cap on stored entries. Oldest evicted first. */
  maxEntries?: number
  now?: () => number
  /** Fired when `create()` evicts an older job to stay within `maxEntries`. The route layer hooks this to abort the SDK call and drop the rendered bytes. */
  onEvict?: (job: VideoJob, reason: VideoEvictReason) => void
}

export type ListVideoJobsOptions = ListJobsOptions

export interface VideoJobsStore {
  create: (input: {
    model: string
    prompt: string | null
    size: string
    seconds: string
  }) => VideoJob
  update: (
    id: string,
    patch: Partial<Omit<VideoJob, 'id' | 'object' | 'controller'>>
  ) => VideoJob | undefined
  get: (id: string) => VideoJob | undefined
  delete: (id: string) => boolean
  list: (opts?: ListVideoJobsOptions) => JobsPage<VideoJob>
  size: () => number
  bannerLine: () => string
}

// The route-level resource carries no real TTL — the rendered bytes have
// their own TTL in the ephemeral file store, and `/content` returns 410
// `video_expired` once they're gone. We surface a static far-future timestamp
// (year 9999) so the OpenAI shape remains non-null.
const EXPIRES_AT_SENTINEL = 253402300799

export function createVideoJobsStore(options: VideoJobsStoreOptions = {}): VideoJobsStore {
  const nowMs = options.now ?? ((): number => Date.now())
  const jobs = createJobsStore<VideoJob>({
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    createdAt: (job) => job.created_at,
    ...(options.onEvict !== undefined ? { onEvict: options.onEvict } : {})
  })

  return {
    create(input): VideoJob {
      return jobs.add({
        id: `video_${randomBytes(12).toString('hex')}`,
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
      })
    },
    update: jobs.update,
    get: jobs.get,
    delete: jobs.delete,
    list: jobs.list,
    size: jobs.size,
    bannerLine(): string {
      return `videos: in-memory only — job IDs and rendered bytes are lost on restart, max ${jobs.maxEntries} entries`
    }
  }
}
