import type { ModelRegistry, ServeConfig, ModelEntry } from '../core/model-registry.js'
import type { Logger } from '../../logger.js'
import type { VectorStoresStore } from '../adapters/openai/vector-stores-store.js'
import type { EphemeralFilesStore } from '../adapters/openai/ephemeral-files-store.js'
import type { ChunkAttributionStore } from '../adapters/openai/chunk-attribution-store.js'
import type { ResponsesStore } from '../adapters/openai/responses-store.js'
import type { VideoJobsStore } from '../core/video-jobs-store.js'
import type * as sdk from '@qvac/sdk'
import type { ParsedFile } from './multipart.js'

export interface QvacContext {
  registry: ModelRegistry
  serveConfig: ServeConfig
  logger: Logger
  vectorStores: VectorStoresStore
  ephemeralFiles: EphemeralFilesStore
  chunkAttributions: ChunkAttributionStore
  responsesStore: ResponsesStore
  videoJobsStore: VideoJobsStore
  /** Set at server start: `true` when `ffmpeg` is on PATH (probed once).
   * Gates both video MP4 transcoding and audio mp3/opus/aac/flac encoding. */
  ffmpegAvailable: boolean
  transcribeOverride?: (opts: {
    modelId: string
    audioChunk: Buffer
    prompt?: string | undefined
  }) => Promise<string> & { requestId: string }
  /** Test seam — overrides `video()` from `@qvac/sdk` when set. */
  videoOverride?: typeof sdk.video
  /** Test seam — overrides `cancel()` from `@qvac/sdk` when set. */
  cancelOverride?: typeof sdk.cancel
}

export interface QvacRequestModel {
  alias: string
  sdkModelId: string
  entry: ModelEntry
}

declare module 'fastify' {
  interface FastifyInstance {
    qvac: QvacContext
  }
  interface FastifyRequest {
    qvacModel?: QvacRequestModel
    bindCancel: (requestId: string) => void
    multipartFiles?: ParsedFile[]
  }
  interface FastifyContextConfig {
    unsupportedParams?: string[]
    sseSentinel?: boolean
  }
}
