import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ModelRegistry, ServeConfig } from '../core/model-registry.js'
import type { Logger } from '../../logger.js'

export interface RouteContext {
  registry: ModelRegistry
  serveConfig: ServeConfig
  logger: Logger
  /** @internal Unit tests only — replaces sdkTranscribe when set */
  transcribeOverride?: (opts: {
    modelId: string
    audioChunk: Buffer
    fileName: string
    prompt?: string | undefined
  }) => Promise<string>
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<void> | void

export interface APIAdapter {
  name: string
  prefix: string
  route: (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => Promise<boolean>
}
