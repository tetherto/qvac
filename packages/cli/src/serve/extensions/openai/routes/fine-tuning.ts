import { randomBytes, randomInt } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  finetune,
  type FinetuneHandle,
  type FinetuneProgress,
  type FinetuneResult,
  type FinetuneRunParams,
  type FinetuneStopParams
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { isLifecycleBlockedError } from '@/serve/core/lifecycle'
import { resolveAndCheckModel } from '@/serve/core/plugins/require-model'
import type { QvacContext } from '@/serve/core/context'
import { openaiState } from '@/serve/extensions/openai/state'
import {
  ACTIVE_STATUSES,
  fineTuningJobResource,
  type FineTuningHyperparameters,
  type FineTuningJob,
  type FineTuningJobsStore
} from '@/serve/extensions/openai/fine-tuning-jobs-store'
import {
  checkTrainingFile,
  fineTuningCreateBody,
  fineTuningEventList,
  fineTuningJobIdParam,
  fineTuningJobList,
  fineTuningJobResource as fineTuningJobSchema,
  fineTuningListQuery,
  type FineTuningCreateBody
} from '@/serve/extensions/openai/schemas/fine-tuning'

const ADMIN_REFUSED = {
  admin_disabled: 'The server was started without `--enable-admin`',
  origin_not_allowed: 'A browser request from an origin outside the CORS allowlist'
}
const SUSPENDED = { runtime_suspended: 'The runtime is not active; resume it first' }
const NOT_FOUND = { job_not_found: 'No job with this id' }

const ADAPTER_FILE = 'trained-lora-adapter.gguf'
const PAUSE_SETTLE_MS = 30_000
const STOP_SETTLE_MS = 30_000
// The addon's default floor of 0 makes the last cosine step run at rate 0, which aborts the worker.
const MIN_LEARNING_RATE = 1e-8

const descriptions = {
  create: `
Start a LoRA fine-tuning job on a chat model, backed by the SDK's
\`finetune()\`. **Admin-only:** needs \`--enable-admin\`.

\`training_file\` and \`validation_file\` are ids from \`POST /v1/files\` uploaded
with \`purpose: "fine-tune"\`. Each line is \`{"messages": [{"role", "content"}, ...]}\`
with at least one assistant message. The server copies the bytes into the job,
so the uploads may expire while the job runs.

Only \`method.type: "supervised"\` is supported. \`learning_rate_multiplier\`
must be \`"auto"\`; set an absolute rate in \`qvac.learning_rate\`.

One job per model at a time: a model with a queued, running or paused job
answers \`409 model_busy\`. Training holds the model exclusively, so chat on the
same alias waits until the job ends or pauses.

Jobs, checkpoints and adapters live in memory and a temp directory: a restart
loses them.
`.trim(),
  list: 'List fine-tuning jobs, newest first. Cursor pagination via `after` / `limit`.',
  retrieve: `
\`status\` moves \`queued\` → \`running\` → \`succeeded | failed | cancelled\`.
\`running\` starts at the first training step, so a job waiting for the model
stays \`queued\`. \`paused\` jobs continue with \`POST /resume\`.
`.trim(),
  cancel:
    'Cancel a queued, running or paused job. Its checkpoints are deleted; a cancelled job cannot resume.',
  pause: `
Pause a running job at the next step and keep its checkpoint. Answers once the
trainer has stopped, or after 30 s with the job still \`running\`.
`.trim(),
  resume: 'Resume a paused job from its checkpoint. Loads the model again if it was unloaded.',
  events: `
Status changes and per-step training metrics, newest first. \`metrics\` events
carry \`data.step\`, \`data.epoch\` and \`train_loss\` / \`train_mean_token_accuracy\`
or \`valid_loss\` / \`valid_mean_token_accuracy\`. The last 1000 events are kept.
`.trim(),
  content: `
Download the trained LoRA adapter (GGUF) of a \`succeeded\` job. Load it on a
model with \`config.lora\` in \`serve.models\`.
`.trim()
}

export interface FineTuningOperations {
  run: (params: FinetuneRunParams) => FinetuneHandle
  control: (params: FinetuneStopParams) => Promise<FinetuneResult>
}

const SDK_OPERATIONS: FineTuningOperations = {
  run: (params) => finetune(params),
  control: (params) => finetune(params)
}

function operations(ctx: QvacContext): FineTuningOperations {
  return openaiState(ctx).fineTuningOverride ?? SDK_OPERATIONS
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function finite(n: number | null): n is number {
  return n !== null && Number.isFinite(n)
}

function recordProgress(store: FineTuningJobsStore, job: FineTuningJob, p: FinetuneProgress): void {
  job.estimated_finish = p.eta_ms > 0 ? Math.floor((Date.now() + p.eta_ms) / 1000) : null
  const prefix = p.is_train ? 'train' : 'valid'
  const data: Record<string, number> = { step: p.global_steps, epoch: p.current_epoch }
  if (finite(p.loss)) data[`${prefix}_loss`] = p.loss
  if (finite(p.accuracy)) data[`${prefix}_mean_token_accuracy`] = p.accuracy
  const loss = finite(p.loss)
    ? ` ${prefix === 'train' ? 'training' : 'validation'} loss=${p.loss.toFixed(4)}`
    : ''
  store.addEvent(job, {
    level: 'info',
    type: 'metrics',
    message: `Step ${p.global_steps}:${loss}`,
    data
  })
}

async function removeJobDir(ctx: QvacContext, job: FineTuningJob): Promise<void> {
  await rm(job.dir, { recursive: true, force: true }).catch((err: unknown) => {
    ctx.logger.debug(`  fine_tuning job=${job.id} cleanup failed: ${errorMessage(err)}`)
  })
}

async function runJob(
  ctx: QvacContext,
  job: FineTuningJob,
  operation: 'start' | 'resume'
): Promise<void> {
  const store = openaiState(ctx).fineTuningJobs
  ctx.logger.info(`  fine_tuning ${operation} job=${job.id} model=${job.model}`)
  try {
    const handle = operations(ctx).run({
      modelId: job.sdkModelId,
      operation,
      options: job.sdkOptions
    })
    let lastStep: string | null = null
    const drain = (async (): Promise<void> => {
      try {
        for await (const p of handle.progressStream) {
          if (job.status === 'queued') store.setStatus(job, 'running')
          const key = `${p.is_train}:${p.global_steps}`
          if (key === lastStep) continue
          lastStep = key
          recordProgress(store, job, p)
        }
      } catch {
        // `result` carries the failure.
      }
    })()
    const [result] = await Promise.all([handle.result, drain])

    if (job.cancelRequested) return
    if (result.status === 'COMPLETED') {
      const adapter = join(job.sdkOptions.outputParametersDir, ADAPTER_FILE)
      const exists = await stat(adapter).then(
        (s) => s.isFile(),
        () => false
      )
      if (!exists) throw new Error('Training finished without writing an adapter.')
      store.setStatus(job, 'succeeded')
      ctx.logger.info(`  fine_tuning job=${job.id} succeeded`)
    } else if (result.status === 'PAUSED') {
      store.setStatus(job, 'paused')
    } else if (result.status === 'CANCELLED') {
      job.cancelRequested = true
      store.setStatus(job, 'cancelled')
    } else {
      throw new Error(`Training ended with unexpected status ${result.status}.`)
    }
  } catch (err) {
    if (job.cancelRequested) return
    const message = errorMessage(err)
    ctx.logger.error(`  fine_tuning job=${job.id} failed: ${message}`)
    job.error = { code: 'fine_tuning_failed', message, param: null }
    store.setStatus(job, 'failed', `Fine-tuning job failed: ${message}`)
  } finally {
    job.run = null
    if (job.status === 'failed' || job.status === 'cancelled') await removeJobDir(ctx, job)
  }
}

function startRun(ctx: QvacContext, job: FineTuningJob, operation: 'start' | 'resume'): void {
  job.run = runJob(ctx, job, operation)
}

/**
 * Stops a job's training and drops its files. Used by cancel, eviction and
 * shutdown; never throws. Waits up to `waitMs` for the trainer to stop.
 */
export async function tearDownFineTuningJob(
  ctx: QvacContext,
  job: FineTuningJob,
  waitMs = STOP_SETTLE_MS
): Promise<void> {
  const running = job.run
  if (running !== null) {
    try {
      await operations(ctx).control({ modelId: job.sdkModelId, operation: 'cancel' })
    } catch (err) {
      ctx.logger.debug(`  fine_tuning job=${job.id} cancel failed: ${errorMessage(err)}`)
    }
    await settled(running, waitMs)
  }
  await removeJobDir(ctx, job)
}

function resolveHyperparameters(body: FineTuningCreateBody): FineTuningHyperparameters {
  if (body.method !== undefined && body.method.type !== 'supervised') {
    throw new HttpError(
      400,
      'unsupported_method',
      `method.type "${body.method.type}" is not supported; use "supervised".`
    )
  }
  if (
    body.integrations !== undefined &&
    body.integrations !== null &&
    body.integrations.length > 0
  ) {
    throw new HttpError(400, 'unsupported_parameter', 'integrations are not supported.')
  }
  const hp = body.method?.supervised?.hyperparameters ?? body.hyperparameters ?? {}
  if (hp.learning_rate_multiplier !== undefined && hp.learning_rate_multiplier !== 'auto') {
    throw new HttpError(
      400,
      'unsupported_parameter',
      'learning_rate_multiplier must be "auto". Set an absolute rate in qvac.learning_rate.'
    )
  }
  return {
    n_epochs: hp.n_epochs ?? 'auto',
    batch_size: hp.batch_size ?? 'auto',
    learning_rate_multiplier: 'auto'
  }
}

function readDataset(ctx: QvacContext, fileId: string, param: string): Buffer {
  const record = ctx.files.get(fileId)
  if (!record) {
    throw new HttpError(404, 'file_not_found', `${param}: no file with id "${fileId}".`)
  }
  if (record.purpose !== 'fine-tune') {
    throw new HttpError(
      400,
      'invalid_file_purpose',
      `${param}: file "${fileId}" has purpose "${record.purpose}"; upload it with purpose "fine-tune".`
    )
  }
  const problem = checkTrainingFile(record.data.toString('utf8'))
  if (problem !== null) {
    throw new HttpError(400, `invalid_${param}`, `${param}: ${problem}.`)
  }
  return record.data
}

function getJob(store: FineTuningJobsStore, id: string): FineTuningJob {
  const job = store.get(id)
  if (!job) throw new HttpError(404, 'job_not_found', `No fine-tuning job with id "${id}".`)
  return job
}

function controlFailed(ctx: QvacContext, job: FineTuningJob, action: string, err: unknown): never {
  if (isLifecycleBlockedError(err)) throw err
  ctx.logger.error(`  fine_tuning ${action} job=${job.id} failed: ${errorMessage(err)}`)
  throw new HttpError(500, `${action}_failed`, `Failed to ${action} the fine-tuning job.`)
}

async function settled(run: Promise<void> | null, ms: number): Promise<void> {
  if (run === null) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    run,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
  ])
  clearTimeout(timer)
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.qvac
  const openai = openaiState(ctx)
  const store = openai.fineTuningJobs

  app.addHook('onClose', async () => {
    await Promise.all(store.all().map((job) => tearDownFineTuningJob(ctx, job, 0)))
    await rm(openai.fineTuningRoot, { recursive: true, force: true }).catch(() => {})
  })

  app.post(
    '/v1/fine_tuning/jobs',
    {
      config: { admin: true },
      schema: {
        body: fineTuningCreateBody,
        tags: ['Fine-tuning'],
        summary: 'Create a fine-tuning job',
        description: descriptions.create,
        response: {
          200: fineTuningJobSchema,
          ...errorResponses({
            400: {
              missing_model: '`model` is missing',
              invalid_model_type: 'The model is not a chat model',
              invalid_file_purpose: 'A dataset was not uploaded with `purpose: "fine-tune"`',
              invalid_training_file: 'A training-file line is not a chat example',
              invalid_validation_file: 'A validation-file line is not a chat example',
              unsupported_method: '`method.type` is not `supervised`',
              unsupported_parameter:
                'A numeric `learning_rate_multiplier`, or a non-empty `integrations`'
            },
            403: ADMIN_REFUSED,
            404: {
              model_not_found: 'The model is not in `serve.models`',
              file_not_found: 'A dataset file id is unknown or expired'
            },
            409: { model_busy: 'The model already has a queued, running or paused job' },
            503: {
              ...SUSPENDED,
              model_not_loaded: 'The model is not loaded and lazy loading is off',
              model_load_failed: 'The model failed to load',
              model_load_timeout: 'The model took too long to load'
            }
          })
        }
      }
    },
    async (req, reply) => {
      const body = req.body
      const hyperparameters = resolveHyperparameters(body)
      const training = readDataset(ctx, body.training_file, 'training_file')
      const validationId = body.validation_file ?? null
      const validation =
        validationId !== null ? readDataset(ctx, validationId, 'validation_file') : null

      const { alias, sdkModelId } = await resolveAndCheckModel(
        req,
        reply,
        (body.model ?? '').trim(),
        'chat'
      )
      const dir = join(openai.fineTuningRoot, randomBytes(8).toString('hex'))
      await mkdir(dir, { recursive: true })
      const trainPath = join(dir, 'train.jsonl')
      await writeFile(trainPath, training)
      let validationPath: string | null = null
      if (validation !== null) {
        validationPath = join(dir, 'validation.jsonl')
        await writeFile(validationPath, validation)
      }

      // No await between this check and `store.create`, so concurrent creates can't both pass.
      const busy = store.activeFor(sdkModelId)
      if (busy) {
        await rm(dir, { recursive: true, force: true })
        throw new HttpError(
          409,
          'model_busy',
          `Model "${alias}" already has fine-tuning job ${busy.id} (${busy.status}). Cancel it or wait for it to finish.`
        )
      }

      const q = body.qvac ?? {}
      const seed = body.seed ?? randomInt(0, 2 ** 31 - 1)
      const job = store.create({
        model: alias,
        sdkModelId,
        dir,
        training_file: body.training_file,
        validation_file: validationId,
        hyperparameters,
        seed,
        suffix: body.suffix ?? null,
        metadata: body.metadata ?? null,
        sdkOptions: {
          trainDatasetDir: trainPath,
          validation:
            validationPath !== null ? { type: 'dataset', path: validationPath } : { type: 'none' },
          outputParametersDir: join(dir, 'adapter'),
          checkpointSaveDir: join(dir, 'checkpoints'),
          assistantLossOnly: true,
          loraSeed: seed,
          lrMin: Math.min(MIN_LEARNING_RATE, q.learning_rate ?? MIN_LEARNING_RATE),
          ...(hyperparameters.n_epochs !== 'auto' && {
            numberOfEpochs: hyperparameters.n_epochs
          }),
          ...(hyperparameters.batch_size !== 'auto' && { batchSize: hyperparameters.batch_size }),
          ...(q.learning_rate !== undefined && { learningRate: q.learning_rate }),
          ...(q.lora_rank !== undefined && { loraRank: q.lora_rank }),
          ...(q.lora_alpha !== undefined && { loraAlpha: q.lora_alpha }),
          ...(q.lora_modules !== undefined && { loraModules: q.lora_modules }),
          ...(q.context_length !== undefined && { contextLength: q.context_length })
        }
      })
      store.setStatus(job, 'queued')
      startRun(ctx, job, 'start')
      return fineTuningJobResource(job)
    }
  )

  app.get(
    '/v1/fine_tuning/jobs',
    {
      config: { admin: true },
      schema: {
        querystring: fineTuningListQuery,
        tags: ['Fine-tuning'],
        summary: 'List fine-tuning jobs',
        description: descriptions.list,
        response: {
          200: fineTuningJobList,
          ...errorResponses({ 403: ADMIN_REFUSED, 503: SUSPENDED })
        }
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const page = store.list({
        ...(req.query.after !== undefined && { after: req.query.after }),
        ...(req.query.limit !== undefined && { limit: req.query.limit })
      })
      return {
        object: 'list' as const,
        data: page.data.map(fineTuningJobResource),
        has_more: page.has_more
      }
    }
  )

  app.get(
    '/v1/fine_tuning/jobs/:id',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        tags: ['Fine-tuning'],
        summary: 'Retrieve a fine-tuning job',
        description: descriptions.retrieve,
        response: {
          200: fineTuningJobSchema,
          ...errorResponses({ 403: ADMIN_REFUSED, 404: NOT_FOUND, 503: SUSPENDED })
        }
      }
    },
    // lunte-disable-next-line require-await
    async (req) => fineTuningJobResource(getJob(store, req.params.id))
  )

  app.post(
    '/v1/fine_tuning/jobs/:id/cancel',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        tags: ['Fine-tuning'],
        summary: 'Cancel a fine-tuning job',
        description: descriptions.cancel,
        response: {
          200: fineTuningJobSchema,
          ...errorResponses({
            403: ADMIN_REFUSED,
            404: NOT_FOUND,
            409: { job_not_cancellable: 'The job already succeeded, failed or was cancelled' },
            503: SUSPENDED
          })
        }
      }
    },
    async (req) => {
      const job = getJob(store, req.params.id)
      if (!ACTIVE_STATUSES.has(job.status)) {
        throw new HttpError(
          409,
          'job_not_cancellable',
          `Job ${job.id} is ${job.status} and cannot be cancelled.`
        )
      }
      job.cancelRequested = true
      store.setStatus(job, 'cancelled')
      await tearDownFineTuningJob(ctx, job)
      return fineTuningJobResource(job)
    }
  )

  app.post(
    '/v1/fine_tuning/jobs/:id/pause',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        tags: ['Fine-tuning'],
        summary: 'Pause a fine-tuning job',
        description: descriptions.pause,
        response: {
          200: fineTuningJobSchema,
          ...errorResponses({
            403: ADMIN_REFUSED,
            404: NOT_FOUND,
            409: { job_not_pausable: 'The job is not running' },
            500: { pause_failed: 'The SDK could not pause the job' },
            503: SUSPENDED
          })
        }
      }
    },
    async (req) => {
      const job = getJob(store, req.params.id)
      if (job.status !== 'running') {
        throw new HttpError(
          409,
          'job_not_pausable',
          `Job ${job.id} is ${job.status}; only a running job can be paused.`
        )
      }
      try {
        await operations(ctx).control({ modelId: job.sdkModelId, operation: 'pause' })
      } catch (err) {
        controlFailed(ctx, job, 'pause', err)
      }
      await settled(job.run, PAUSE_SETTLE_MS)
      return fineTuningJobResource(job)
    }
  )

  app.post(
    '/v1/fine_tuning/jobs/:id/resume',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        tags: ['Fine-tuning'],
        summary: 'Resume a paused fine-tuning job',
        description: descriptions.resume,
        response: {
          200: fineTuningJobSchema,
          ...errorResponses({
            403: ADMIN_REFUSED,
            404: NOT_FOUND,
            409: {
              job_not_resumable: 'The job is not paused',
              model_busy: 'Another job holds the model'
            },
            503: {
              ...SUSPENDED,
              model_not_loaded: 'The model is not loaded and lazy loading is off',
              model_load_failed: 'The model failed to load'
            }
          })
        }
      }
    },
    async (req, reply) => {
      const job = getJob(store, req.params.id)
      if (job.status !== 'paused' || job.run !== null) {
        throw new HttpError(
          409,
          'job_not_resumable',
          `Job ${job.id} is ${job.status}; only a paused job can be resumed.`
        )
      }
      const { sdkModelId } = await resolveAndCheckModel(req, reply, job.model, 'chat')
      const busy = store.activeFor(sdkModelId)
      if (busy && busy !== job) {
        throw new HttpError(
          409,
          'model_busy',
          `Model "${job.model}" already has fine-tuning job ${busy.id} (${busy.status}).`
        )
      }
      job.sdkModelId = sdkModelId
      store.setStatus(job, 'queued', 'Fine-tuning job resumed')
      startRun(ctx, job, 'resume')
      return fineTuningJobResource(job)
    }
  )

  app.get(
    '/v1/fine_tuning/jobs/:id/events',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        querystring: fineTuningListQuery,
        tags: ['Fine-tuning'],
        summary: 'List fine-tuning job events',
        description: descriptions.events,
        response: {
          200: fineTuningEventList,
          ...errorResponses({ 403: ADMIN_REFUSED, 404: NOT_FOUND, 503: SUSPENDED })
        }
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const job = getJob(store, req.params.id)
      const page = store.events(job, {
        ...(req.query.after !== undefined && { after: req.query.after }),
        ...(req.query.limit !== undefined && { limit: req.query.limit })
      })
      return { object: 'list' as const, ...page }
    }
  )

  app.get(
    '/v1/fine_tuning/jobs/:id/content',
    {
      config: { admin: true },
      schema: {
        params: fineTuningJobIdParam,
        tags: ['Fine-tuning'],
        summary: 'Download the trained adapter',
        description: descriptions.content,
        produces: ['application/octet-stream'],
        response: errorResponses({
          403: ADMIN_REFUSED,
          404: NOT_FOUND,
          409: { job_not_succeeded: 'The job has not succeeded' },
          410: { adapter_missing: 'The adapter file is gone from the server' },
          503: SUSPENDED
        })
      }
    },
    async (req, reply) => {
      const job = getJob(store, req.params.id)
      if (job.status !== 'succeeded') {
        throw new HttpError(
          409,
          'job_not_succeeded',
          `Job ${job.id} is ${job.status}; the adapter is available once it succeeds.`
        )
      }
      const path = join(job.sdkOptions.outputParametersDir, ADAPTER_FILE)
      const size = await stat(path).then(
        (s) => s.size,
        () => null
      )
      if (size === null) {
        throw new HttpError(410, 'adapter_missing', `The adapter for job ${job.id} is gone.`)
      }
      return reply
        .type('application/octet-stream')
        .header('Content-Length', size)
        .header('Content-Disposition', `attachment; filename="${job.id}.gguf"`)
        .send(createReadStream(path))
    }
  )
}

export default plugin
