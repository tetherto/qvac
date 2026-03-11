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
      sendError(res, 500, 'internal_error', message)
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
      const adapterNames = adapters.map((a) => a.name).join(', ')
      logger.info(`QVAC API server listening on http://${host}:${port}`)
      logger.info(`Adapters: ${adapterNames}`)
      logger.info('Endpoints: POST /v1/chat/completions, POST /v1/embeddings, GET /v1/models')
      resolve(server)
    })
  })
}

function logResponse (logger: Logger, method: string, path: string, status: number, start: number): void {
  const ms = performance.now() - start
  const duration = ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`
  logger.info(`← ${status} ${method} ${path} (${duration})`)
}
