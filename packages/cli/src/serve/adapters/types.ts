import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ModelRegistry, ServeConfig } from '../core/model-registry.js'
import type { Logger } from '../../logger.js'
import type { ChunkAttributionStore } from './openai/chunk-attribution-store.js'
import type { EphemeralFilesStore } from './openai/ephemeral-files-store.js'
import type { VectorStoresStore } from './openai/vector-stores-store.js'
import type { ResponsesStore } from './openai/responses-store.js'

export interface RouteContext {
  registry: ModelRegistry
  serveConfig: ServeConfig
  logger: Logger
  vectorStores: VectorStoresStore
  ephemeralFiles: EphemeralFilesStore
  chunkAttributions: ChunkAttributionStore
  responsesStore: ResponsesStore
  /** @internal Unit tests only — replaces the SDK `transcribe` when set */
  transcribeOverride?: (opts: {
    modelId: string
    audioChunk: Buffer
    prompt?: string | undefined
  }) => Promise<string> & { requestId: string }
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void

export interface APIAdapter {
  name: string
  prefix: string
  route: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>
}
