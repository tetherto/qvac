import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply } from 'fastify'
import { video, cancel } from '@qvac/sdk'
import type { VideoClientParams } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { requireModel } from '../plugins/require-model.js'
import {
  videosCreateBody,
  videoResource,
  videoListResource,
  deletedVideoResource,
  videoIdParam,
  videosListQuery,
  videoContentQuery,
  extractVideoCreateParams
} from '../schemas/videos.js'
import type { VideoJob } from '../core/video-jobs-store.js'
import { videoJobResource } from '../core/video-jobs-store.js'
import { transcodeAviToMp4, TranscodeFailedError, TranscodeTimeoutError } from '../lib/video-transcode.js'
import type { QvacContext } from '../lib/types.js'

const descriptions = {
  create: `
Async text-to-video. Returns immediately with \`status: queued\`; poll
\`GET /v1/videos/{id}\` and fetch bytes from \`GET /v1/videos/{id}/content\`
once \`status: completed\`. JSON body only — multipart isn't accepted because
the only OpenAI use for it is \`input_reference\`, which this server rejects
(no image-to-video in the SDK).

**Job store is in-memory only.** IDs and rendered bytes are lost on restart.
`.trim(),
  retrieve: `
\`status\` cycles \`queued\` → \`in_progress\` → \`completed | failed\`.
\`progress\` plateaus during VAE-decode / AVI-mux phases after denoising.
\`expires_at\` is a far-future sentinel — the bytes have their own TTL in
the ephemeral-file store, and \`/content\` returns \`410 video_expired\` once
they're gone.
`.trim(),
  content: `
Default \`Content-Type\` is \`video/mp4\` (transcoded from the SDK's native
MJPG-AVI via the system \`ffmpeg\` binary into fragmented MP4 — required
because we pipe to a non-seekable stdout). Falls back to \`video/avi\` if
ffmpeg isn't on PATH at server start (warned once).

The transcode is lazy and cached: first request after \`status: completed\`
may take seconds; subsequent requests serve the cached MP4.

\`?format=mp4\` or \`?format=avi\` force the container. \`?format=mp4\` with
no ffmpeg → \`503 transcode_unavailable\`. \`variant=thumbnail|spritesheet\`
→ \`501 unsupported_variant\` (not rendered). Failures: \`404 video_not_found\`,
\`409 video_not_ready\` (with \`Retry-After\`), \`410 video_expired\`,
\`502 transcode_failed\` (retry with \`?format=avi\`).
`.trim(),
  list: 'List video jobs, newest first by default. Cursor pagination via `limit` / `order` / `after`. In-memory only.',
  delete: 'Delete a job and its rendered assets. If still `queued` / `in_progress`, generation is aborted first.'
}

const VIDEO_AVI_CONTENT_TYPE = 'video/avi' as const
const VIDEO_MP4_CONTENT_TYPE = 'video/mp4' as const
const RETRY_AFTER_SECONDS = 2

/**
 * Single source of truth for "this job is going away — release everything it
 * owns". Called from the DELETE handler AND from the store's `onEvict`
 * callback (max-entries pressure), so DELETE and silent eviction share the
 * same teardown: abort the local controller (interrupts the drain loop),
 * cancel the SDK request if we have its `requestId`, and remove any
 * ephemeral-file ids backing the rendered bytes.
 *
 * No-throw — runs in fire-and-forget contexts (server-side eviction) where a
 * thrown cancel-RPC failure would crash the surrounding hook. SDK cancel
 * failures are logged at DEBUG.
 */
function tearDownJob (ctx: QvacContext, job: VideoJob): void {
  if (job.status === 'queued' || job.status === 'in_progress') {
    try { job.controller.abort() } catch { /* noop */ }
    if (job.requestId) {
      const cancelFn = ctx.cancelOverride ?? cancel
      cancelFn({ requestId: job.requestId }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger.debug(`  video_teardown job=${job.id} cancel failed: ${message}`)
      })
    }
  }
  if (job.aviFileId) ctx.ephemeralFiles.remove(job.aviFileId)
  if (job.mp4FileId) ctx.ephemeralFiles.remove(job.mp4FileId)
}

export { tearDownJob }

async function runVideoJob (ctx: QvacContext, jobId: string, params: VideoClientParams, alias: string): Promise<void> {
  const store = ctx.videoJobsStore
  const job = store.get(jobId)
  if (!job) return
  ctx.logger.info(`  video_create job=${jobId} model=${alias} prompt_chars=${params.prompt.length} size=${job.size} seconds=${job.seconds}`)

  try {
    const videoFn = ctx.videoOverride ?? video
    const result = videoFn(params)

    // Stash requestId so DELETE / onEvict can cancel via the SDK. If
    // store.update returns undefined the job is already gone (DELETE /
    // eviction ran while video() was being constructed) — issue the cancel
    // here since tearDownJob couldn't, then bail.
    const stored = store.update(jobId, { requestId: result.requestId })
    if (!stored) {
      const cancelFn = ctx.cancelOverride ?? cancel
      cancelFn({ requestId: result.requestId }).catch(() => { /* noop */ })
      ctx.logger.info(`  video_create job=${jobId} torn down before run; cancelled requestId=${result.requestId}`)
      return
    }

    // SDK reports progress per pipeline phase (sampler → VAE decode → mux),
    // each starting at step=0. Publish as a monotonic high-water mark.
    let maxProgress = 0
    let started = false
    const drainProgress = async (): Promise<void> => {
      try {
        for await (const tick of result.progressStream) {
          if (job.controller.signal.aborted) break
          if (!started) {
            started = true
            store.update(jobId, { status: 'in_progress' })
          }
          const pct = tick.totalSteps > 0 ? (tick.step / tick.totalSteps) * 100 : 0
          const clamped = Math.max(0, Math.min(99, Math.round(pct)))
          if (clamped > maxProgress) {
            maxProgress = clamped
            store.update(jobId, { progress: clamped })
          }
          ctx.logger.debug(`    video_create job=${jobId} step=${tick.step}/${tick.totalSteps} elapsed=${tick.elapsedMs}ms`)
        }
      } catch {
        // outputs/stats below surface the real error
      }
    }

    const [buffers, stats] = await Promise.all([result.outputs, result.stats, drainProgress()])

    if (job.controller.signal.aborted) {
      ctx.logger.info(`  video_create job=${jobId} aborted`)
      return
    }

    const buffer = buffers[0]
    if (!buffer || buffer.length === 0) {
      throw new Error('video generation produced no output')
    }

    const aviFileId = ctx.ephemeralFiles.put({
      data: Buffer.from(buffer),
      fileName: `video-${jobId}.avi`,
      purpose: 'video',
      contentType: VIDEO_AVI_CONTENT_TYPE
    })

    // Caller didn't pin width/height → backfill `size` from stats.
    const size = job.size.length > 0
      ? job.size
      : (stats?.width != null && stats?.height != null ? `${stats.width}x${stats.height}` : '')

    // The abort check above already handles DELETE / eviction on the normal
    // path. The store-update return is a second check: if the job is gone we
    // remove the just-put AVI from ephemeralFiles instead of leaving it to
    // age out via that store's TTL. Same pattern as the mp4 write below.
    const updated = store.update(jobId, {
      status: 'completed',
      progress: 100,
      completed_at: Math.floor(Date.now() / 1000),
      size,
      aviFileId
    })
    if (!updated) {
      ctx.ephemeralFiles.remove(aviFileId)
      ctx.logger.info(`  video_create job=${jobId} bytes dropped (job torn down during generation)`)
      return
    }
    ctx.logger.info(`  video_create job=${jobId} done frames=${stats?.videoFrames ?? '?'} bytes=${buffer.length} avi_file=${aviFileId}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`  video_create job=${jobId} failed: ${message}`)
    store.update(jobId, {
      status: 'failed',
      error: { code: 'video_generation_failed', message }
    })
  }
}

async function serveContent (
  reply: FastifyReply,
  ctx: QvacContext,
  job: VideoJob,
  formatOverride: 'mp4' | 'avi' | undefined
): Promise<void> {
  if (job.status !== 'completed') {
    if (job.status === 'failed') {
      throw new HttpError(409, 'video_failed', `Video generation failed: ${job.error?.message ?? 'unknown error'}`)
    }
    reply.header('Retry-After', String(RETRY_AFTER_SECONDS))
    throw new HttpError(409, 'video_not_ready', `Video status is "${job.status}". Poll GET /v1/videos/${job.id} until completed.`)
  }

  if (!job.aviFileId) {
    throw new HttpError(410, 'video_expired', `Video bytes for job ${job.id} are no longer available.`)
  }
  const aviRecord = ctx.ephemeralFiles.get(job.aviFileId)
  if (!aviRecord) {
    ctx.videoJobsStore.update(job.id, { aviFileId: null, mp4FileId: null })
    throw new HttpError(410, 'video_expired', `Video bytes for job ${job.id} are no longer available.`)
  }

  const wantMp4 = formatOverride === 'mp4' || (formatOverride === undefined && ctx.ffmpegAvailable)

  if (!wantMp4) {
    reply
      .header('Content-Type', VIDEO_AVI_CONTENT_TYPE)
      .header('Content-Length', aviRecord.data.length)
      .send(aviRecord.data)
    return
  }

  if (!ctx.ffmpegAvailable) {
    throw new HttpError(503, 'transcode_unavailable', 'ffmpeg is not on PATH on this server; cannot transcode AVI → MP4. Omit ?format or use ?format=avi.')
  }

  let mp4Buffer: Buffer | null = null
  if (job.mp4FileId) {
    const cached = ctx.ephemeralFiles.get(job.mp4FileId)
    if (cached) mp4Buffer = cached.data
    else ctx.videoJobsStore.update(job.id, { mp4FileId: null })
  }

  if (!mp4Buffer) {
    try {
      mp4Buffer = await transcodeAviToMp4(aviRecord.data)
    } catch (err) {
      if (err instanceof TranscodeTimeoutError) {
        ctx.logger.error(`  video_content job=${job.id} transcode timed out: ${err.message}`)
        throw new HttpError(502, 'transcode_failed', `${err.message}. Retry with ?format=avi to fetch the native container.`)
      }
      if (err instanceof TranscodeFailedError) {
        const stderrTail = err.stderr.trim().split('\n').slice(-5).join(' | ')
        ctx.logger.error(`  video_content job=${job.id} ffmpeg exit=${err.exitCode ?? '?'} stderr: ${stderrTail || '(empty)'}`)
        throw new HttpError(
          502,
          'transcode_failed',
          `${err.message}. Retry with ?format=avi to fetch the native container.`
        )
      }
      throw err
    }
    const mp4FileId = ctx.ephemeralFiles.put({
      data: mp4Buffer,
      fileName: `video-${job.id}.mp4`,
      purpose: 'video',
      contentType: VIDEO_MP4_CONTENT_TYPE
    })
    // The transcode awaited above takes seconds; a DELETE / eviction landing
    // in that window leaves the job gone from the store. Cache the mp4 only
    // if the job is still reachable — otherwise the entry would orphan in
    // ephemeralFiles until that store's own TTL drops it. We still serve the
    // bytes for this in-flight request (the client asked, we already paid for
    // the transcode).
    const updated = ctx.videoJobsStore.update(job.id, { mp4FileId })
    if (!updated) {
      ctx.ephemeralFiles.remove(mp4FileId)
      ctx.logger.debug(`  video_content job=${job.id} mp4 cache dropped (job torn down during transcode)`)
    }
  }

  reply
    .header('Content-Type', VIDEO_MP4_CONTENT_TYPE)
    .header('Content-Length', mp4Buffer.length)
    .send(mp4Buffer)
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/videos', {
    schema: {
      body: videosCreateBody,
      tags: ['Videos'],
      summary: 'Create a video generation job',
      description: descriptions.create,
      response: { 200: videoResource }
    },
    preHandler: requireModel('video')
  }, async (req, reply) => {
    const ctx = app.qvac
    const { alias, sdkModelId } = req.qvacModel!
    const params = extractVideoCreateParams(req.body, sdkModelId)

    const job = ctx.videoJobsStore.create({
      model: alias,
      prompt: params.prompt,
      size: params.width != null && params.height != null ? `${params.width}x${params.height}` : '',
      seconds: req.body.seconds ?? ''
    })

    // Detach: the route returns immediately; the background task drives the SDK.
    void runVideoJob(ctx, job.id, params, alias)

    reply.status(200).send(videoJobResource(job))
  })

  app.get('/v1/videos', {
    schema: {
      querystring: videosListQuery,
      tags: ['Videos'],
      summary: 'List video generation jobs',
      description: descriptions.list,
      response: { 200: videoListResource }
    }
  }, async (req) => {
    const q = req.query
    const page = app.qvac.videoJobsStore.list({
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.order !== undefined ? { order: q.order } : {}),
      ...(q.after !== undefined ? { after: q.after } : {})
    })
    return {
      object: 'list' as const,
      data: page.data.map(videoJobResource),
      first_id: page.first_id,
      last_id: page.last_id,
      has_more: page.has_more
    }
  })

  app.get('/v1/videos/:id', {
    schema: {
      params: videoIdParam,
      tags: ['Videos'],
      summary: 'Retrieve a video generation job',
      description: descriptions.retrieve,
      response: { 200: videoResource }
    }
  }, async (req) => {
    const job = app.qvac.videoJobsStore.get(req.params.id)
    if (!job) {
      throw new HttpError(404, 'video_not_found', `No video job with id "${req.params.id}".`)
    }
    return videoJobResource(job)
  })

  app.get('/v1/videos/:id/content', {
    schema: {
      params: videoIdParam,
      querystring: videoContentQuery,
      tags: ['Videos'],
      summary: 'Download a generated video',
      description: descriptions.content
    }
  }, async (req, reply) => {
    const ctx = app.qvac
    const job = ctx.videoJobsStore.get(req.params.id)
    if (!job) {
      throw new HttpError(404, 'video_not_found', `No video job with id "${req.params.id}".`)
    }

    const variant = req.query.variant
    if (variant !== undefined && variant !== 'video') {
      throw new HttpError(
        501,
        'unsupported_variant',
        `variant=${JSON.stringify(variant)} is not supported by this server. Only variant="video" is available.`
      )
    }

    await serveContent(reply, ctx, job, req.query.format)
  })

  app.delete('/v1/videos/:id', {
    schema: {
      params: videoIdParam,
      tags: ['Videos'],
      summary: 'Delete a video generation job',
      description: descriptions.delete,
      response: { 200: deletedVideoResource }
    }
  }, async (req) => {
    const ctx = app.qvac
    const job = ctx.videoJobsStore.get(req.params.id)
    if (!job) {
      throw new HttpError(404, 'video_not_found', `No video job with id "${req.params.id}".`)
    }
    // Drop the store entry first so a racing runVideoJob (still mid-`video()`
    // call) sees `store.update` return undefined and self-cancels with the
    // freshly-acquired requestId.
    ctx.videoJobsStore.delete(req.params.id)
    tearDownJob(ctx, job)
    return {
      id: req.params.id,
      object: 'video.deleted' as const,
      deleted: true as const
    }
  })
}

export default plugin
