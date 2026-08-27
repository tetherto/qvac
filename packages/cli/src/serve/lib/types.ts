import type { ModelRegistry, ServeConfig, ModelEntry } from '../core/model-registry.js'
import type { LoadManager, LoadModelFn } from '../core/load-manager.js'
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
  loadManager: LoadManager
  logger: Logger
  vectorStores: VectorStoresStore
  ephemeralFiles: EphemeralFilesStore
  chunkAttributions: ChunkAttributionStore
  responsesStore: ResponsesStore
  videoJobsStore: VideoJobsStore
  /** Set at server start: `true` when `ffmpeg` is on PATH (probed once).
   * Gates both video MP4 transcoding and audio mp3/opus/aac/flac encoding. */
  ffmpegAvailable: boolean
  transcribeOverride?: (
    opts: Parameters<typeof sdk.transcribe>[0]
  ) => Promise<string | sdk.TranscribeSegment[]> & { requestId: string }
  /** Test seam — overrides `video()` from `@qvac/sdk` when set. */
  videoOverride?: typeof sdk.video
  /** Test seam — overrides `translate()` from `@qvac/sdk` when set. */
  translateOverride?: typeof sdk.translate
  /** Test seam — overrides `cancel()` from `@qvac/sdk` when set. */
  cancelOverride?: typeof sdk.cancel
  /** Test seam — overrides the SDK model load when set, so lazy-load and preload
   * can be exercised without a real (expensive) model load. Backed by an
   * accessor in `buildServer`, hence the explicit `| undefined`. */
  loadModelOverride?: LoadModelFn | undefined
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
