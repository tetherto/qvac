import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from '../logger.js'
import type { Logger } from '../logger.js'
import { findConfigFile, loadConfig } from '../config.js'
import { parseServeConfig } from './config.js'
import { createModelRegistry } from './core/model-registry.js'
import { preloadModels, shutdownSDK } from './core/lifecycle.js'
import { handleCors, sendError } from './http.js'
import { createOpenAIAdapter } from './adapters/openai/index.js'
import type { APIAdapter, RouteContext } from './adapters/types.js'
import type { ServeConfig, ResolvedModelEntry } from './core/model-registry.js'

export interface StartServerOptions {
  projectRoot: string
  config?: string | undefined
  port: number
  host: string
  model?: string[] | undefined
  apiKey?: string | undefined
  cors?: boolean | undefined
  verbose?: boolean | undefined
}

export async function startServer (options: StartServerOptions): Promise<http.Server> {
  const logger = createLogger(options.verbose ? 'debug' : 'info')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 11434

  const configPath = findConfigFile(options.projectRoot, options.config)
  const rawConfig = configPath ? await loadConfig(configPath) as Record<string, unknown> : {}
  const serveConfig = await parseServeConfig(rawConfig as Parameters<typeof parseServeConfig>[0], options)
  const registry = createModelRegistry()

  await preloadModels(serveConfig, registry, logger)

  const adapters: APIAdapter[] = [
    createOpenAIAdapter()
  ]

  const ctx: RouteContext = { registry, serveConfig, logger }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const start = performance.now()
    const method = req.method ?? ''
    const path = (req.url ?? '').split('?')[0] ?? ''

    if (method === 'OPTIONS') {
      if (options.cors) handleCors(req, res)
      else {
        res.writeHead(204)
        res.end()
      }
      return
    }

    logger.info(`→ ${method} ${path}`)

    if (options.cors) handleCors(req, res)

    if (options.apiKey) {
      const auth = req.headers['authorization']
      if (!auth || auth !== `Bearer ${options.apiKey}`) {
        sendError(res, 401, 'invalid_api_key', 'Invalid or missing API key.')
        logResponse(logger, method, path, 401, start)
        return
      }
    }

    try {
      for (const adapter of adapters) {
        const handled = await adapter.route(req, res, ctx)
        if (handled) {
          logResponse(logger, method, path, res.statusCode, start)
          return
        }
      }

      sendError(res, 404, 'not_found', `Unknown endpoint: ${method} ${path}`)
      logResponse(logger, method, path, 404, start)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Unhandled error: ${message}`)
      sendError(res, 500, 'internal_error', 'An internal error occurred.')
      logResponse(logger, method, path, 500, start)
    }
  })

  const shutdown = (): void => {
    logger.info('Shutting down...')
    server.close(async () => {
      await shutdownSDK(logger)
      logger.info('Server stopped.')
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10000)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      logger.info(`QVAC API server listening on http://${host}:${port}`)
      logStartupSummary(serveConfig, logger)
      resolve(server)
    })
  })
}

const CATEGORY_ENDPOINTS: Record<string, string[]> = {
  chat: ['POST /v1/chat/completions'],
  embedding: ['POST /v1/embeddings'],
  transcription: ['POST /v1/audio/transcriptions']
}

const MANAGEMENT_ENDPOINTS = [
  'GET  /v1/models',
  'GET  /v1/models/:id',
  'DELETE /v1/models/:id'
]

const CATEGORY_LABELS: Record<string, string> = {
  chat: 'chat',
  embedding: 'embedding',
  transcription: 'transcription',
  translation: 'translation',
  speech: 'speech',
  ocr: 'ocr'
}

function logStartupSummary (serveConfig: ServeConfig, logger: Logger): void {
  const categories = new Set<string>()
  const grouped = new Map<string, ResolvedModelEntry[]>()

  for (const [, entry] of serveConfig.models) {
    categories.add(entry.endpointCategory)
    const list = grouped.get(entry.endpointCategory) ?? []
    list.push(entry)
    grouped.set(entry.endpointCategory, list)
  }

  logger.info('')
  logger.info('Models:')
  if (grouped.size === 0) {
    logger.info('  (none configured)')
  } else {
    for (const [category, entries] of grouped) {
      const label = CATEGORY_LABELS[category] ?? category
      logger.info(`  ${label}:`)
      for (const entry of entries) {
        const tags: string[] = []
        if (entry.isDefault) tags.push('default')
        if (entry.preload) tags.push('preload')
        const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : ''
        logger.info(`    ${entry.alias}${tagStr}`)
      }
    }
  }

  logger.info('')
  logger.info('Endpoints:')
  for (const cat of categories) {
    const endpoints = CATEGORY_ENDPOINTS[cat]
    if (endpoints) {
      for (const ep of endpoints) logger.info(`  ${ep}`)
    }
  }
  for (const ep of MANAGEMENT_ENDPOINTS) logger.info(`  ${ep}`)
  logger.info('')
}

function logResponse (logger: Logger, method: string, path: string, status: number, start: number): void {
  const ms = performance.now() - start
  const duration = ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`
  logger.info(`← ${status} ${method} ${path} (${duration})`)
}
