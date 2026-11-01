import { randomBytes } from 'node:crypto'
import type { AudioGenStats } from '@qvac/sdk'
import {
  createJobsStore,
  type JobEvictReason,
  type ListJobsOptions
} from '@/serve/core/stores/jobs'

export type MusicJobKind = 'generation' | 'edit'
export type MusicJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/** The wire shape of `/qvac/v1/audio/{generations,edits}` jobs. */
export interface MusicJobResource<K extends MusicJobKind = MusicJobKind> {
  id: string
  object: `audio.${K}`
  model: string
  status: MusicJobStatus
  progress: number
  stage: string | null
  created_at: number
  completed_at: number | null
  error: { code: string; message: string } | null
  stats: AudioGenStats | null
}

export interface MusicJob<K extends MusicJobKind = MusicJobKind> extends MusicJobResource<K> {
  /** SDK requestId, for `cancel()` on DELETE or eviction. */
  requestId: string
  /** Ephemeral file holding the rendered WAV, set once completed. */
  wavFileId: string | null
  controller: AbortController
}

export function musicJobResource<K extends MusicJobKind>(job: MusicJob<K>): MusicJobResource<K> {
  const { requestId, wavFileId, controller, ...resource } = job
  void requestId
  void wavFileId
  void controller
  return resource
}

export interface MusicJobsPage<K extends MusicJobKind = MusicJobKind> {
  data: Array<MusicJob<K>>
  first_id: string | null
  last_id: string | null
  has_more: boolean
}

export interface MusicJobsStore<K extends MusicJobKind = MusicJobKind> {
  readonly kind: K
  create: (input: { model: string; requestId: string }) => MusicJob<K>
  update: (
    id: string,
    patch: Partial<Omit<MusicJob, 'id' | 'object' | 'controller'>>
  ) => MusicJob<K> | undefined
  get: (id: string) => MusicJob<K> | undefined
  delete: (id: string) => boolean
  list: (opts?: ListJobsOptions) => MusicJobsPage<K>
  readonly maxEntries: number
}

const ID_PREFIX: Record<MusicJobKind, string> = {
  generation: 'audiogen',
  edit: 'audioedit'
}

export function createMusicJobsStore<K extends MusicJobKind>(
  kind: K,
  options: {
    maxEntries?: number
    now?: () => number
    onEvict?: (job: MusicJob<K>, reason: JobEvictReason) => void
  } = {}
): MusicJobsStore<K> {
  const nowMs = options.now ?? ((): number => Date.now())
  const jobs = createJobsStore<MusicJob<K>>({
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    createdAt: (job) => job.created_at,
    ...(options.onEvict !== undefined ? { onEvict: options.onEvict } : {})
  })

  return {
    kind,
    create(input): MusicJob<K> {
      return jobs.add({
        id: `${ID_PREFIX[kind]}_${randomBytes(12).toString('hex')}`,
        object: `audio.${kind}` as const,
        model: input.model,
        status: 'queued',
        progress: 0,
        stage: null,
        created_at: Math.floor(nowMs() / 1000),
        completed_at: null,
        error: null,
        stats: null,
        requestId: input.requestId,
        wavFileId: null,
        controller: new AbortController()
      })
    },
    update: jobs.update,
    get: jobs.get,
    delete: jobs.delete,
    list(opts): MusicJobsPage<K> {
      const page = jobs.list(opts)
      return {
        data: page.items,
        first_id: page.firstId,
        last_id: page.lastId,
        has_more: page.hasMore
      }
    },
    maxEntries: jobs.maxEntries
  }
}
