import { randomBytes } from 'node:crypto'
import type { FinetuneRunParams } from '@qvac/sdk'
import {
  createJobsStore,
  type JobEvictReason,
  type ListJobsOptions
} from '@/serve/core/stores/jobs'

export type FineTuningJobStatus =
  'validating_files' | 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'

export const ACTIVE_STATUSES: ReadonlySet<FineTuningJobStatus> = new Set([
  'validating_files',
  'queued',
  'running',
  'paused'
])

export type HyperparameterValue = number | 'auto'

export interface FineTuningHyperparameters {
  n_epochs: HyperparameterValue
  batch_size: HyperparameterValue
  learning_rate_multiplier: HyperparameterValue
}

export interface FineTuningJobError {
  code: string
  message: string
  param: string | null
}

/** OpenAI `fine_tuning.job` object. */
export interface FineTuningJobResource {
  id: string
  object: 'fine_tuning.job'
  model: string
  created_at: number
  finished_at: number | null
  fine_tuned_model: null
  organization_id: string
  result_files: string[]
  status: FineTuningJobStatus
  training_file: string
  validation_file: string | null
  hyperparameters: FineTuningHyperparameters
  method: {
    type: 'supervised'
    supervised: { hyperparameters: FineTuningHyperparameters }
  }
  trained_tokens: null
  error: FineTuningJobError | null
  seed: number
  estimated_finish: number | null
  integrations: []
  metadata: Record<string, string> | null
  user_provided_suffix: string | null
}

export interface FineTuningJobEvent {
  id: string
  object: 'fine_tuning.job.event'
  created_at: number
  level: 'info' | 'warn' | 'error'
  message: string
  type: 'message' | 'metrics'
  data?: Record<string, number>
}

/** Internal record: the OpenAI resource plus server-side run state. */
export interface FineTuningJob extends FineTuningJobResource {
  sdkModelId: string
  /** SDK options for this job; a resume reuses them unchanged. */
  sdkOptions: FinetuneRunParams['options']
  /** Job-owned directory holding the dataset copies, checkpoints and adapter. */
  dir: string
  /** Newest last; capped at `MAX_EVENTS`. */
  events: FineTuningJobEvent[]
  /** Settles when the current SDK run ends; null while nothing runs. */
  run: Promise<void> | null
  /** Set when the client cancels, so the run's outcome can't overwrite it. */
  cancelRequested: boolean
}

export function fineTuningJobResource(job: FineTuningJob): FineTuningJobResource {
  const { sdkModelId, sdkOptions, dir, events, run, cancelRequested, ...resource } = job
  void sdkModelId
  void sdkOptions
  void dir
  void events
  void run
  void cancelRequested
  return resource
}

const MAX_EVENTS = 1000
const ORGANIZATION_ID = 'qvac-local'

export interface FineTuningJobsPage {
  data: FineTuningJob[]
  has_more: boolean
}

export interface FineTuningEventsPage {
  data: FineTuningJobEvent[]
  has_more: boolean
}

export interface CreateFineTuningJobInput {
  model: string
  sdkModelId: string
  sdkOptions: FinetuneRunParams['options']
  dir: string
  training_file: string
  validation_file: string | null
  hyperparameters: FineTuningHyperparameters
  seed: number
  suffix: string | null
  metadata: Record<string, string> | null
}

export interface FineTuningJobsStore {
  create: (input: CreateFineTuningJobInput) => FineTuningJob
  get: (id: string) => FineTuningJob | undefined
  list: (opts?: Pick<ListJobsOptions, 'limit' | 'after'>) => FineTuningJobsPage
  all: () => FineTuningJob[]
  /** The job that holds `sdkModelId` right now, if any. */
  activeFor: (sdkModelId: string) => FineTuningJob | undefined
  setStatus: (job: FineTuningJob, status: FineTuningJobStatus, message?: string) => void
  addEvent: (
    job: FineTuningJob,
    event: Omit<FineTuningJobEvent, 'id' | 'object' | 'created_at'>
  ) => void
  events: (job: FineTuningJob, opts?: { limit?: number; after?: string }) => FineTuningEventsPage
  bannerLine: () => string
}

export interface FineTuningJobsStoreOptions {
  maxEntries?: number
  now?: () => number
  onEvict?: (job: FineTuningJob, reason: JobEvictReason) => void
}

const STATUS_MESSAGES: Partial<Record<FineTuningJobStatus, string>> = {
  validating_files: 'Validating training file',
  queued: 'Fine-tuning job queued',
  running: 'Fine-tuning job started',
  paused: 'Fine-tuning job paused',
  succeeded: 'The job has successfully completed',
  cancelled: 'Fine-tuning job cancelled'
}

export function createFineTuningJobsStore(
  options: FineTuningJobsStoreOptions = {}
): FineTuningJobsStore {
  const nowMs = options.now ?? ((): number => Date.now())
  const nowSeconds = (): number => Math.floor(nowMs() / 1000)
  // `created_at` has second resolution; order same-second jobs by creation.
  const order = new WeakMap<FineTuningJob, number>()
  let sequence = 0
  const jobs = createJobsStore<FineTuningJob>({
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    createdAt: (job) => order.get(job) ?? 0,
    ...(options.onEvict !== undefined ? { onEvict: options.onEvict } : {})
  })

  function addEvent(
    job: FineTuningJob,
    event: Omit<FineTuningJobEvent, 'id' | 'object' | 'created_at'>
  ): void {
    job.events.push({
      id: `ftevent-${randomBytes(12).toString('hex')}`,
      object: 'fine_tuning.job.event',
      created_at: nowSeconds(),
      ...event
    })
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS)
  }

  return {
    create(input): FineTuningJob {
      const job: FineTuningJob = {
        id: `ftjob-${randomBytes(12).toString('hex')}`,
        object: 'fine_tuning.job',
        model: input.model,
        created_at: nowSeconds(),
        finished_at: null,
        fine_tuned_model: null,
        organization_id: ORGANIZATION_ID,
        result_files: [],
        status: 'validating_files',
        training_file: input.training_file,
        validation_file: input.validation_file,
        hyperparameters: input.hyperparameters,
        method: { type: 'supervised', supervised: { hyperparameters: input.hyperparameters } },
        trained_tokens: null,
        error: null,
        seed: input.seed,
        estimated_finish: null,
        integrations: [],
        metadata: input.metadata,
        user_provided_suffix: input.suffix,
        sdkModelId: input.sdkModelId,
        sdkOptions: input.sdkOptions,
        dir: input.dir,
        events: [],
        run: null,
        cancelRequested: false
      }
      addEvent(job, {
        level: 'info',
        type: 'message',
        message: `Created fine-tuning job: ${job.id}`
      })
      order.set(job, sequence++)
      return jobs.add(job)
    },

    get: jobs.get,

    list(opts): FineTuningJobsPage {
      const page = jobs.list({ ...opts, order: 'desc' })
      return { data: page.items, has_more: page.hasMore }
    },

    all: jobs.values,

    activeFor(sdkModelId): FineTuningJob | undefined {
      return jobs.values().find((j) => j.sdkModelId === sdkModelId && ACTIVE_STATUSES.has(j.status))
    },

    setStatus(job, status, message): void {
      if (job.status === status) return
      job.status = status
      if (!ACTIVE_STATUSES.has(status)) {
        job.finished_at = nowSeconds()
        job.estimated_finish = null
      }
      const text = message ?? STATUS_MESSAGES[status]
      if (text !== undefined) {
        addEvent(job, {
          level: status === 'failed' ? 'error' : 'info',
          type: 'message',
          message: text
        })
      }
    },

    addEvent,

    events(job, opts): FineTuningEventsPage {
      const limit = opts?.limit !== undefined && opts.limit > 0 ? Math.min(opts.limit, 100) : 20
      const newestFirst = [...job.events].reverse()
      let start = 0
      if (opts?.after !== undefined) {
        const idx = newestFirst.findIndex((e) => e.id === opts.after)
        start = idx >= 0 ? idx + 1 : newestFirst.length
      }
      const data = newestFirst.slice(start, start + limit)
      return { data, has_more: start + data.length < newestFirst.length }
    },

    bannerLine(): string {
      return `fine-tuning: in-memory only — jobs, checkpoints and adapters are lost on restart, max ${jobs.maxEntries} entries`
    }
  }
}
