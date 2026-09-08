import type * as sdk from '@qvac/sdk'
import type { QvacContext } from '@/serve/core/context'
import { createResponsesStore } from '@/serve/extensions/openai/adapters/responses-store'
import { createChunkAttributionStore } from '@/serve/extensions/openai/adapters/chunk-attribution-store'
import { createEphemeralFilesStore } from '@/serve/extensions/openai/adapters/ephemeral-files-store'
import { createVectorStoresStore } from '@/serve/extensions/openai/adapters/vector-stores-store'
import type { VectorStoresStore } from '@/serve/extensions/openai/adapters/vector-stores-store'
import type { EphemeralFilesStore } from '@/serve/extensions/openai/adapters/ephemeral-files-store'
import type { ChunkAttributionStore } from '@/serve/extensions/openai/adapters/chunk-attribution-store'
import type { ResponsesStore } from '@/serve/extensions/openai/adapters/responses-store'
import { createVideoJobsStore } from '@/serve/extensions/openai/video-jobs-store'
import type { VideoJobsStore } from '@/serve/extensions/openai/video-jobs-store'
import { tearDownJob } from '@/serve/extensions/openai/routes/videos'
import { probeFfmpegAvailable } from '@/serve/lib/video-transcode'

export interface OpenAIState {
  responsesStore: ResponsesStore
  vectorStores: VectorStoresStore
  ephemeralFiles: EphemeralFilesStore
  chunkAttributions: ChunkAttributionStore
  videoJobsStore: VideoJobsStore
  /** Set at server start: `true` when `ffmpeg` is on PATH (probed once).
   * Gates both video MP4 transcoding and audio mp3/opus/aac/flac encoding. */
  ffmpegAvailable: boolean
  transcribeOverride?: (
    opts: Parameters<typeof sdk.transcribe>[0]
  ) => Promise<string | sdk.TranscribeSegment[]> & { requestId: string }
  /** Test seam — overrides `video()` from `@qvac/sdk` when set. */
  videoOverride?: typeof sdk.video
  /** Test seam — overrides `cancel()` from `@qvac/sdk` when set. */
  cancelOverride?: typeof sdk.cancel
}

declare module '@/serve/core/context' {
  interface ServeExtensionState {
    openai: OpenAIState
  }
}

export interface OpenAIExtensionOptions {
  transcribeOverride?: OpenAIState['transcribeOverride']
}

export function openaiState(ctx: QvacContext): OpenAIState {
  const state = ctx.extensions.openai
  if (state === undefined) {
    throw new Error('The openai extension is not mounted.')
  }
  return state
}

export async function createOpenAIState(
  ctx: QvacContext,
  options: OpenAIExtensionOptions | undefined
): Promise<OpenAIState> {
  const { logger } = ctx

  const ffmpegAvailable = await probeFfmpegAvailable()
  if (!ffmpegAvailable) {
    logger.warn(
      'ffmpeg not on PATH — /v1/videos/{id}/content defaults to video/avi and /v1/audio/speech rejects mp3/opus/aac/flac. Install ffmpeg to serve those. See: qvac doctor'
    )
  }

  // `onEvict` reaches this state back through `ctx`, which only holds it once
  // setup returns. The closure runs lazily (only when the store actually
  // evicts), by which point the slot is populated.
  const state: OpenAIState = {
    responsesStore: createResponsesStore(),
    vectorStores: createVectorStoresStore(),
    ephemeralFiles: createEphemeralFilesStore(undefined, {
      onEvict: (id, reason) => {
        logger.warn(`ephemeral file evicted id=${id} reason=${reason}`)
      }
    }),
    chunkAttributions: createChunkAttributionStore(),
    videoJobsStore: createVideoJobsStore({
      onEvict: (job, reason) => {
        logger.warn(`video job evicted id=${job.id} reason=${reason} status=${job.status}`)
        tearDownJob(ctx, job)
      }
    }),
    ffmpegAvailable,
    ...(options?.transcribeOverride !== undefined
      ? { transcribeOverride: options.transcribeOverride }
      : {})
  }

  return state
}

export function openaiBanners(state: OpenAIState): string[] {
  return [state.responsesStore.bannerLine(), state.videoJobsStore.bannerLine()]
}
