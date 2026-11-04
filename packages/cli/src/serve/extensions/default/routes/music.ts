import { unlink } from 'node:fs/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'
import type { z } from 'zod'
import {
  audioEdit,
  audioGen,
  audioUnderstand,
  cancel,
  RequestValidationFailedError,
  type AudioGenResult
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses, type ErrorCodes } from '@/serve/lib/error-responses'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { resolveBinaryInput, type BinaryInput } from '@/serve/lib/binary-input'
import { writeTempAudio } from '@/serve/lib/temp-audio'
import {
  transcodeWav,
  probeFfmpegAvailable,
  AudioEncodeFailedError,
  AudioEncodeTimeoutError,
  type EncodedSpeechFormat
} from '@/serve/lib/audio-transcode'
import { buildWavHeader } from '@/serve/extensions/openai/audio'
import { requireModel } from '@/serve/core/plugins/require-model'
import type { QvacContext } from '@/serve/core/context'
import { defaultState } from '@/serve/extensions/default/state'
import {
  musicJobResource,
  type MusicJob,
  type MusicJobKind,
  type MusicJobsStore
} from '@/serve/extensions/default/music-jobs-store'
import {
  audioEditBody,
  audioEditParams,
  audioEditResource,
  audioGenerationBody,
  audioGenerationResource,
  audioGenParams,
  audioContentQuery,
  audioJobIdParam,
  audioJobsListQuery,
  audioUnderstandingBody,
  audioUnderstandingResult,
  audioUnderstandParams,
  deletedJobResource,
  jobListResource
} from '@/serve/extensions/default/schemas/music'

type AudioField = 'sourceAudio' | 'referenceAudio'
type AudioInputs = Partial<Record<AudioField, BinaryInput>>
type AudioPaths = Partial<Record<AudioField, string>>

const RETRY_AFTER_SECONDS = 2

const CONTENT_TYPES: Record<'wav' | EncodedSpeechFormat, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  aac: 'audio/aac'
}

// Filled before the model is required, so a bad upload is refused without loading it.
const audioInputs = new WeakMap<FastifyRequest, AudioInputs>()

const INPUT_ERRORS: ErrorCodes = {
  invalid_json: 'Body is not valid JSON',
  invalid_multipart: 'The multipart body could not be parsed',
  missing_model: '`model` is missing',
  invalid_model_type: 'The alias is not an `audiogen` model',
  empty_input: 'An audio input is empty',
  invalid_data_url: 'An audio input is a data URL that is not base64',
  file_not_found: 'An audio input names no uploaded file',
  invalid_request:
    'An unknown field, a field of the wrong type, or a combination the SDK refuses (the message names it)'
}

const MODEL_ERRORS = {
  404: { model_not_found: 'Unknown alias' },
  413: { request_too_large: 'The body exceeds the upload limit' },
  503: {
    model_not_loaded: 'The model is not loaded and lazy loading is disabled',
    model_not_ready: 'The model is still loading',
    model_load_failed: 'The model failed to load',
    model_load_timeout: 'The model load timed out'
  }
}

interface JobRoute {
  kind: MusicJobKind
  path: string
}

const TAG = 'Music'
const GENERATIONS: JobRoute = { kind: 'generation', path: '/qvac/v1/audio/generations' }
const EDITS: JobRoute = { kind: 'edit', path: '/qvac/v1/audio/edits' }

const JOB_NOTE = `
Returns at once with \`status: queued\`. Poll \`GET {path}/{id}\` until
\`status\` is \`completed\` or \`failed\`, then fetch the audio from
\`GET {path}/{id}/content\`. \`DELETE\` cancels a running job.

Send JSON or \`multipart/form-data\`. Each audio input is a multipart file
part, a base64 data URL, or the \`id\` of a file uploaded with
\`POST /v1/files\`, in any format the SDK audio decoder reads.

**The job store is in-memory only.** IDs and audio are lost on restart, and the
rendered audio expires with the server's file store.
`.trim()

const descriptions = {
  generations: `
Generate music with an \`audiogen\` model, backed by the SDK's \`audioGen()\`.
Fields mirror its arguments; \`model\` names the alias.

${JOB_NOTE.replaceAll('{path}', GENERATIONS.path)}
`.trim(),
  edits: `
Edit a recording with an ACE-Step \`audiogen\` model, backed by the SDK's
\`audioEdit()\`: an ordered pipeline of \`flow-edit\` and \`repaint\`
operations over \`sourceAudio\`. In a multipart body, send \`operations\` as
JSON text.

${JOB_NOTE.replaceAll('{path}', EDITS.path)}
`.trim(),
  understandings: `
Describe a recording with an ACE-Step \`audiogen\` model, backed by the SDK's
\`audioUnderstand()\`: a caption, BPM, key, time signature, language and
the recovered semantic codes, which a generation takes back as \`audioCodes\`.

Send JSON or \`multipart/form-data\`; \`sourceAudio\` takes the same forms as
the generation inputs. The request runs to completion; a client disconnect
cancels it.
`.trim(),
  content: `
The rendered audio. \`wav\` (the default) is 16-bit PCM at the engine's rate;
\`mp3\`, \`flac\`, \`opus\` (Ogg) and \`aac\` (ADTS) are encoded with the
system \`ffmpeg\` on each request.
`.trim()
}

/**
 * Releases what a job owns: aborts and cancels a running run and drops its
 * audio. Called on DELETE and on store eviction, so it never throws.
 */
export function tearDownMusicJob(ctx: QvacContext, job: MusicJob): void {
  const state = defaultState(ctx)
  if (job.status === 'queued' || job.status === 'in_progress') {
    job.controller.abort()
    const cancelFn = state.cancelOverride ?? cancel
    cancelFn({ requestId: job.requestId }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger.debug(`  audio_teardown job=${job.id} cancel failed: ${message}`)
    })
  }
  if (job.wavFileId) ctx.files.remove(job.wavFileId)
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const preHandler = [
    // lunte-disable-next-line require-await
    async function (req: FastifyRequest) {
      audioInputs.set(req, resolveAudioInputs(req))
    },
    requireModel('audiogen')
  ]

  app.post(
    GENERATIONS.path,
    {
      schema: {
        body: audioGenerationBody,
        response: {
          200: audioGenerationResource,
          ...errorResponses({
            400: { ...INPUT_ERRORS, missing_caption: '`caption` is missing or empty' },
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Create a music generation job',
        description: descriptions.generations,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler
    },
    async (req) => {
      const { alias, sdkModelId } = req.qvacModel!
      const state = defaultState(app.qvac)
      const run = await startRun(audioInputs.get(req)!, (paths) =>
        (state.audioGenOverride ?? audioGen)(audioGenParams(req.body, sdkModelId, paths))
      )
      app.qvac.logger.info(
        `  audio_generation model=${alias} caption_chars=${req.body.caption.length}`
      )
      return musicJobResource(createJob(app.qvac, state.musicJobs.generation, alias, run))
    }
  )

  app.post(
    EDITS.path,
    {
      schema: {
        body: audioEditBody,
        response: {
          200: audioEditResource,
          ...errorResponses({
            400: {
              ...INPUT_ERRORS,
              missing_source_audio: '`sourceAudio` is missing',
              invalid_operations: '`operations` is missing, empty, or malformed'
            },
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Create a music edit job',
        description: descriptions.edits,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler
    },
    async (req) => {
      const { alias, sdkModelId } = req.qvacModel!
      const state = defaultState(app.qvac)
      const run = await startRun(audioInputs.get(req)!, (paths) =>
        (state.audioEditOverride ?? audioEdit)(
          audioEditParams(req.body, sdkModelId, { ...paths, sourceAudio: paths.sourceAudio! })
        )
      )
      app.qvac.logger.info(
        `  audio_edit model=${alias} operations=${req.body.operations.map((op) => op.type).join(',')}`
      )
      return musicJobResource(createJob(app.qvac, state.musicJobs.edit, alias, run))
    }
  )

  app.post(
    '/qvac/v1/audio/understandings',
    {
      schema: {
        body: audioUnderstandingBody,
        response: {
          200: audioUnderstandingResult,
          ...errorResponses({
            400: { ...INPUT_ERRORS, missing_source_audio: '`sourceAudio` is missing' },
            ...MODEL_ERRORS,
            502: { audio_understanding_failed: 'The engine failed to describe the recording' }
          })
        },
        tags: [TAG],
        summary: 'Describe a recording',
        description: descriptions.understandings,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler
    },
    async (req) => {
      const { alias, sdkModelId } = req.qvacModel!
      const state = defaultState(app.qvac)
      const files = await writeAudioInputs(audioInputs.get(req)!)
      try {
        const run = callSdk(() =>
          (state.audioUnderstandOverride ?? audioUnderstand)(
            audioUnderstandParams(req.body, sdkModelId, files.paths.sourceAudio!)
          )
        )
        req.bindCancel(run.requestId)
        app.qvac.logger.info(`  audio_understanding model=${alias}`)
        const [description, stats] = await Promise.all([run.description, run.stats]).catch(
          (err: unknown) => {
            if (err instanceof HttpError) throw err
            const message = err instanceof Error ? err.message : String(err)
            app.qvac.logger.error(`  audio_understanding failed model=${alias}: ${message}`)
            throw new HttpError(502, 'audio_understanding_failed', message)
          }
        )
        return {
          object: 'audio.understanding' as const,
          model: alias,
          description,
          ...(stats !== undefined ? { stats } : {})
        }
      } finally {
        await files.cleanup()
      }
    }
  )

  registerJobReads(app, GENERATIONS, audioGenerationResource)
  registerJobReads(app, EDITS, audioEditResource)
}

function registerJobReads(base: FastifyInstance, route: JobRoute, resource: z.ZodType): void {
  const app = base.withTypeProvider<ZodTypeProvider>()
  const store = (): MusicJobsStore => defaultState(app.qvac).musicJobs[route.kind]
  const notFound = { 404: { audio_job_not_found: `No ${route.kind} job with that id` } }

  function find(id: string): MusicJob {
    const job = store().get(id)
    if (!job) {
      throw new HttpError(404, 'audio_job_not_found', `No ${route.kind} job with id "${id}".`)
    }
    return job
  }

  app.get(
    route.path,
    {
      schema: {
        querystring: audioJobsListQuery,
        response: { 200: jobListResource(resource) },
        tags: [TAG],
        summary: `List music ${route.kind} jobs`,
        description: `Newest first by default. Cursor pagination via \`limit\` / \`order\` / \`after\`. In-memory only.`
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const { limit, order, after } = req.query
      const page = store().list({
        ...(limit !== undefined ? { limit } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(after !== undefined ? { after } : {})
      })
      return {
        object: 'list' as const,
        data: page.data.map(musicJobResource),
        first_id: page.first_id,
        last_id: page.last_id,
        has_more: page.has_more
      }
    }
  )

  app.get(
    `${route.path}/:id`,
    {
      schema: {
        params: audioJobIdParam,
        response: { 200: resource, ...errorResponses(notFound) },
        tags: [TAG],
        summary: `Retrieve a music ${route.kind} job`,
        description: '`status` moves `queued` → `in_progress` → `completed` or `failed`.'
      }
    },
    // lunte-disable-next-line require-await
    async (req) => musicJobResource(find(req.params.id))
  )

  app.get(
    `${route.path}/:id/content`,
    {
      schema: {
        params: audioJobIdParam,
        querystring: audioContentQuery,
        response: errorResponses({
          ...notFound,
          409: {
            audio_job_not_ready: 'The job is still running; retry after `Retry-After` seconds',
            audio_job_failed: 'The job failed; its `error` says why'
          },
          410: { audio_expired: 'The rendered audio has expired from the file store' },
          502: { transcode_failed: 'ffmpeg failed to encode the audio; `format=wav` still works' },
          503: {
            transcode_unavailable: 'An encoded `format` was asked for and ffmpeg is not on PATH'
          }
        }),
        tags: [TAG],
        summary: `Download the audio of a music ${route.kind} job`,
        description: descriptions.content
      }
    },
    async (req, reply) => {
      await sendContent(app.qvac, reply, store(), find(req.params.id), req.query.format ?? 'wav')
    }
  )

  app.delete(
    `${route.path}/:id`,
    {
      schema: {
        params: audioJobIdParam,
        response: {
          200: deletedJobResource(`audio.${route.kind}.deleted`),
          ...errorResponses(notFound)
        },
        tags: [TAG],
        summary: `Delete a music ${route.kind} job`,
        description: 'Deletes the job and its audio, cancelling it first if it is still running.'
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const job = find(req.params.id)
      // Dropped first, so a run finishing meanwhile finds no job to complete.
      store().delete(job.id)
      tearDownMusicJob(app.qvac, job)
      return { id: job.id, object: `audio.${route.kind}.deleted` as const, deleted: true as const }
    }
  )
}

function resolveAudioInputs(req: FastifyRequest): AudioInputs {
  const body = req.body as Partial<Record<AudioField, Buffer | string>>
  const inputs: AudioInputs = {}
  for (const field of ['sourceAudio', 'referenceAudio'] as const) {
    const value = body[field]
    if (value !== undefined) inputs[field] = resolveBinaryInput(req, field, value)
  }
  return inputs
}

async function writeAudioInputs(
  inputs: AudioInputs
): Promise<{ paths: AudioPaths; cleanup: () => Promise<void> }> {
  const paths: AudioPaths = {}
  async function cleanup(): Promise<void> {
    await Promise.all(Object.values(paths).map((path) => unlink(path).catch(() => undefined)))
  }
  try {
    for (const [field, input] of Object.entries(inputs) as Array<[AudioField, BinaryInput]>) {
      paths[field] = await writeTempAudio(input.bytes, {
        filename: input.fileName ?? '',
        mimetype: input.mediaType ?? ''
      })
    }
  } catch (err) {
    await cleanup()
    throw err
  }
  return { paths, cleanup }
}

// The SDK validates its arguments synchronously, before any work starts.
function callSdk<T>(call: () => T): T {
  try {
    return call()
  } catch (err) {
    if (err instanceof RequestValidationFailedError) {
      throw new HttpError(400, 'invalid_request', err.message)
    }
    throw err
  }
}

interface StartedRun {
  run: AudioGenResult
  cleanup: () => Promise<void>
}

async function startRun(
  inputs: AudioInputs,
  call: (paths: AudioPaths) => AudioGenResult
): Promise<StartedRun> {
  const files = await writeAudioInputs(inputs)
  try {
    return { run: callSdk(() => call(files.paths)), cleanup: files.cleanup }
  } catch (err) {
    await files.cleanup()
    throw err
  }
}

function createJob<K extends MusicJobKind>(
  ctx: QvacContext,
  store: MusicJobsStore<K>,
  model: string,
  { run, cleanup }: StartedRun
): MusicJob<K> {
  const job = store.create({ model, requestId: run.requestId })
  // Detached: the route answers now and the job record carries the outcome.
  void driveJob(ctx, store, job, run).finally(cleanup)
  return job
}

async function driveJob(
  ctx: QvacContext,
  store: MusicJobsStore,
  job: MusicJob,
  run: AudioGenResult
): Promise<void> {
  const { id } = job
  const { signal } = job.controller

  // Ticks can still arrive after the run settles; they must not reopen the job.
  let settled = false

  // Progress is stage-local: the LM stage reports 1/1 before the much longer
  // DiT and VAE stages start, so a run-wide high-water mark would sit at 99.
  async function drainProgress(): Promise<void> {
    try {
      for await (const tick of run.progressStream) {
        if (signal.aborted || settled) return
        const pct = tick.total > 0 ? Math.round((tick.step / tick.total) * 100) : 0
        store.update(id, { status: 'in_progress', stage: tick.stage, progress: Math.min(99, pct) })
      }
    } catch {
      // `run.audio` reports the failure.
    }
  }

  try {
    const [audio, stats] = await Promise.all([run.audio, run.stats, drainProgress()])
    settled = true
    if (signal.aborted) return
    const pcm = Buffer.from(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength)
    const header = buildWavHeader(pcm.length, audio.sampleRate, audio.channels, audio.bitsPerSample)
    const wavFileId = ctx.files.put({
      data: Buffer.concat([header, pcm]),
      fileName: `${id}.wav`,
      purpose: 'audio',
      contentType: CONTENT_TYPES.wav
    })
    const completed = store.update(id, {
      status: 'completed',
      progress: 100,
      completed_at: Math.floor(Date.now() / 1000),
      stats: stats ?? null,
      wavFileId
    })
    if (!completed) {
      ctx.files.remove(wavFileId)
      return
    }
    ctx.logger.info(`  audio_${store.kind} job=${id} done bytes=${pcm.length}`)
  } catch (err) {
    settled = true
    if (signal.aborted) return
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`  audio_${store.kind} job=${id} failed: ${message}`)
    store.update(id, { status: 'failed', error: { code: `audio_${store.kind}_failed`, message } })
  }
}

async function sendContent(
  ctx: QvacContext,
  reply: FastifyReply,
  store: MusicJobsStore,
  job: MusicJob,
  format: 'wav' | EncodedSpeechFormat
): Promise<void> {
  if (job.status === 'failed') {
    throw new HttpError(
      409,
      'audio_job_failed',
      `The ${store.kind} failed: ${job.error?.message ?? 'unknown error'}`
    )
  }
  if (job.status !== 'completed') {
    reply.header('Retry-After', String(RETRY_AFTER_SECONDS))
    throw new HttpError(
      409,
      'audio_job_not_ready',
      `Job ${job.id} is ${job.status}; poll it until it is completed.`
    )
  }
  const record = job.wavFileId ? ctx.files.get(job.wavFileId) : null
  if (!record) {
    store.update(job.id, { wavFileId: null })
    throw new HttpError(410, 'audio_expired', `The audio of job ${job.id} is no longer available.`)
  }

  let body = record.data
  if (format !== 'wav') {
    const state = defaultState(ctx)
    state.ffmpegAvailable ??= probeFfmpegAvailable()
    if (!(await state.ffmpegAvailable)) {
      throw new HttpError(
        503,
        'transcode_unavailable',
        `ffmpeg is not on PATH on this server, so format=${format} is unavailable. Use format=wav.`
      )
    }
    try {
      body = await transcodeWav(record.data, format)
    } catch (err) {
      if (err instanceof AudioEncodeFailedError || err instanceof AudioEncodeTimeoutError) {
        ctx.logger.error(`  audio_content job=${job.id} format=${format} failed: ${err.message}`)
        throw new HttpError(502, 'transcode_failed', `${err.message}. Retry with format=wav.`)
      }
      throw err
    }
  }

  reply
    .header('Content-Type', CONTENT_TYPES[format])
    .header('Content-Length', body.length)
    .send(body)
}

export default plugin
