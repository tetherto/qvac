import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import autoload from '@fastify/autoload'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider
} from 'fastify-type-provider-zod'
import closeWithGrace from 'close-with-grace'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from '../logger.js'
import type { Logger } from '../logger.js'
import { findConfigFile, loadConfig } from '../config.js'
import { parseServeConfig } from './config.js'
import { createModelRegistry } from './core/model-registry.js'
import { preloadModels, shutdownSDK } from './core/lifecycle.js'
import { createResponsesStore } from './adapters/openai/responses-store.js'
import { createChunkAttributionStore } from './adapters/openai/chunk-attribution-store.js'
import { createEphemeralFilesStore } from './adapters/openai/ephemeral-files-store.js'
import { createVectorStoresStore } from './adapters/openai/vector-stores-store.js'
import { createVideoJobsStore } from './core/video-jobs-store.js'
import { probeFfmpegAvailable } from './lib/video-transcode.js'
import { tearDownJob } from './routes/videos.js'
import type { QvacContext } from './lib/types.js'
import contextPlugin from './plugins/context.js'
import errorHandlerPlugin from './plugins/error-handler.js'
import authPlugin from './plugins/auth.js'
import cancelBridgePlugin from './plugins/cancel-bridge.js'
import { TAG_DESCRIPTIONS } from './route-meta.js'

import './lib/types.js'

export interface StartServerOptions {
  projectRoot: string
  config?: string | undefined
  port: number
  host: string
  model?: string[] | undefined
  apiKey?: string | undefined
  cors?: boolean | undefined
  publicBaseUrl?: string | undefined
  verbose?: boolean | undefined
  /** Silence the logger entirely. Useful when capturing the OpenAPI spec or
   * when other tooling consumes stdout. */
  quiet?: boolean | undefined
  docs?: boolean | undefined
  transcribeOverride?: QvacContext['transcribeOverride']
}

export async function buildServer (options: StartServerOptions): Promise<FastifyInstance> {
  const logger = createLogger(options.quiet ? 'silent' : options.verbose ? 'debug' : 'info')

  const configPath = findConfigFile(options.projectRoot, options.config)
  const rawConfig = configPath ? await loadConfig(configPath) as Record<string, unknown> : {}
  const serveConfig = parseServeConfig(rawConfig as Parameters<typeof parseServeConfig>[0], options)
  const registry = createModelRegistry()

  const responsesStore = createResponsesStore()
  const vectorStores = createVectorStoresStore()
  const ephemeralFiles = createEphemeralFilesStore(undefined, {
    onEvict: (id, reason) => {
      logger.warn(`ephemeral file evicted id=${id} reason=${reason}`)
    }
  })
  const chunkAttributions = createChunkAttributionStore()
  const videoTranscodeAvailable = await probeFfmpegAvailable()
  if (!videoTranscodeAvailable) {
    logger.warn('ffmpeg not on PATH — /v1/videos/{id}/content will default to video/avi. Install ffmpeg to serve video/mp4. See: qvac doctor')
  }
  // `onEvict` captures `qvacContext` by reference; the closure runs lazily
  // (only when the store actually evicts), long after `qvacContext` is wired
  // below, so the forward reference is safe at invocation time.
  const videoJobsStore = createVideoJobsStore({
    onEvict: (job, reason) => {
      logger.warn(`video job evicted id=${job.id} reason=${reason} status=${job.status}`)
      tearDownJob(qvacContext, job)
    }
  })

  const qvacContext: QvacContext = {
    registry,
    serveConfig,
    logger,
    vectorStores,
    ephemeralFiles,
    chunkAttributions,
    responsesStore,
    videoJobsStore,
    videoTranscodeAvailable,
    ...(options.transcribeOverride !== undefined ? { transcribeOverride: options.transcribeOverride } : {})
  }

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 100 * 1024 * 1024,
    ajv: { customOptions: { allErrors: false } }
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(errorHandlerPlugin)
  await app.register(contextPlugin, { context: qvacContext })

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'QVAC OpenAI-compatible API',
        description: 'OpenAI-compatible REST API served by `qvac serve openai`.',
        version: '1.0.0'
      },
      servers: [
        { url: `http://${options.host}:${options.port}`, description: 'this server' }
      ],
      tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      ...(options.apiKey ? { security: [{ bearerAuth: [] }] } : {})
    },
    transform: jsonSchemaTransform
  })

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  if (options.docs) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true }
    })
  }

  // `--docs` implies CORS: the Swagger UI's "Try it out" feature always issues
  // cross-origin requests (browser origin vs spec `servers` URL often differ —
  // localhost vs 127.0.0.1, port forwards, etc.), and the UI is unusable
  // without `Access-Control-Allow-Origin`.
  if (options.cors || options.docs) {
    await app.register(cors, {
      origin: '*',
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      strictPreflight: false
    })
  }

  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 10
    }
  })

  await app.register(cancelBridgePlugin)

  if (options.apiKey) {
    await app.register(authPlugin, { apiKey: options.apiKey })
  }

  app.addHook('onRequest', async (req) => {
    if (!isIntrospectionPath(req.url)) {
      logger.info(`→ ${req.method} ${req.url.split('?')[0]}`)
    }
    ;(req as unknown as { qvacStart: number }).qvacStart = performance.now()
  })
  app.addHook('onResponse', async (req, reply) => {
    if (isIntrospectionPath(req.url)) return
    const start = (req as unknown as { qvacStart?: number }).qvacStart
    const ms = start !== undefined ? performance.now() - start : 0
    const duration = ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`
    logger.info(`← ${reply.statusCode} ${req.method} ${req.url.split('?')[0]} (${duration})`)
  })

  // Preload is intentionally NOT registered as an `onReady` hook: Fastify
  // bounds those hooks by `pluginTimeout` (default 10 s) and model preload
  // routinely takes minutes (a single uncached LLM blob is hundreds of MB
  // over the P2P registry). `startServer()` drives preload imperatively
  // between `app.ready()` and `app.listen()`, matching the legacy
  // pre-Fastify behavior: port doesn't open until models are loaded.
  app.addHook('onClose', async () => {
    await shutdownSDK(logger)
  })

  const __dirname = dirname(fileURLToPath(import.meta.url))
  await app.register(autoload, {
    dir: join(__dirname, 'routes'),
    forceESM: true,
    encapsulate: false
  })

  return app as unknown as FastifyInstance
}

export async function startServer (options: StartServerOptions): Promise<FastifyInstance> {
  const app = await buildServer(options)

  // Resolve plugin registrations (decorators, route table) but DON'T listen
  // yet — that way the imperative preload below can use `app.qvac` while
  // keeping the port closed until models are ready, matching the pre-Fastify
  // semantics that the e2e suite depends on.
  await app.ready()
  await preloadModels(app.qvac.serveConfig, app.qvac.registry, app.qvac.logger)
  app.qvac.logger.warn(app.qvac.responsesStore.bannerLine())
  app.qvac.logger.warn(app.qvac.videoJobsStore.bannerLine())

  closeWithGrace({ delay: 10_000 }, async ({ signal }) => {
    app.log.info?.({ signal }, 'shutdown signal received')
    await app.close()
  })

  await app.listen({ port: options.port, host: options.host })
  app.qvac.logger.info(`QVAC API server listening on http://${options.host}:${options.port}`)
  logStartupSummary(app, app.qvac.logger)
  return app
}

function isIntrospectionPath (url: string): boolean {
  return url === '/openapi.json' || url === '/docs' || url.startsWith('/docs/')
}

function logStartupSummary (app: FastifyInstance, logger: Logger): void {
  logger.info('')
  logger.info('Endpoints:')
  const routes = app.printRoutes({ commonPrefix: false }).split('\n').filter((l) => l.trim().length > 0)
  for (const line of routes) {
    logger.info(`  ${line}`)
  }
  logger.info('')
}
