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

import { createLogger } from '@/logger'
import type { Logger } from '@/logger'
import { findConfigFile, loadConfig } from '@/config'
import { parseServeConfig } from '@/serve/config'
import { createCorsOriginMatcher, isLoopbackHost, normalizeCorsOrigin } from '@/serve/cors'
import { resolveServeApiKey } from '@/serve/api-key'
import { checkNetworkExposure, validateServeStartup } from '@/serve/startup'
import { createModelRegistry } from '@/serve/core/model-registry'
import { createLoadManager, defaultLoadFn } from '@/serve/core/load-manager'
import { preloadModels, shouldRefuseStart, shutdownSDK } from '@/serve/core/lifecycle'
import { createResponsesStore } from '@/serve/adapters/openai/responses-store'
import { createChunkAttributionStore } from '@/serve/adapters/openai/chunk-attribution-store'
import { createEphemeralFilesStore } from '@/serve/adapters/openai/ephemeral-files-store'
import { createVectorStoresStore } from '@/serve/adapters/openai/vector-stores-store'
import { createVideoJobsStore } from '@/serve/core/video-jobs-store'
import { probeFfmpegAvailable } from '@/serve/lib/video-transcode'
import { tearDownJob } from '@/serve/routes/videos'
import type { QvacContext } from '@/serve/lib/types'
import contextPlugin from '@/serve/plugins/context'
import errorHandlerPlugin from '@/serve/plugins/error-handler'
import authPlugin from '@/serve/plugins/auth'
import cancelBridgePlugin from '@/serve/plugins/cancel-bridge'
import { TAG_DESCRIPTIONS } from '@/serve/route-meta'

import '@/serve/lib/types'

export interface StartServerOptions {
  projectRoot: string
  config?: string | undefined
  port: number
  host: string
  model?: string[] | undefined
  apiKey?: string | undefined
  /** Path to a file holding the bearer key, so it stays out of the process argv. */
  apiKeyFile?: string | undefined
  allowUnauthenticated?: boolean | undefined
  cors?: boolean | undefined
  corsOrigins?: string[] | undefined
  publicBaseUrl?: string | undefined
  verbose?: boolean | undefined
  /** Silence the logger entirely. Useful when capturing the OpenAPI spec or
   * when other tooling consumes stdout. */
  quiet?: boolean | undefined
  docs?: boolean | undefined
  lazyLoad?: boolean | undefined
  loadConcurrency?: number | undefined
  loadTimeoutMs?: number | null | undefined
  cancelLoadOnDisconnect?: boolean | undefined
  transcribeOverride?: QvacContext['transcribeOverride']
  loadModelOverride?: QvacContext['loadModelOverride']
}

export async function buildServer(options: StartServerOptions): Promise<FastifyInstance> {
  const logger = createLogger(options.quiet ? 'silent' : options.verbose ? 'debug' : 'info')

  const configPath = findConfigFile(options.projectRoot, options.config)
  const rawConfig = configPath ? ((await loadConfig(configPath)) as Record<string, unknown>) : {}
  const serveConfig = parseServeConfig(rawConfig as Parameters<typeof parseServeConfig>[0], options)
  validateServeStartup(serveConfig.cors.origins, options)
  const { apiKey, warning: apiKeyWarning } = resolveServeApiKey(options)
  if (apiKeyWarning !== undefined) logger.warn(apiKeyWarning)
  // Emitted here, while options resolve, so an operator sees it before the
  // socket opens rather than after a preload that can run for minutes.
  const exposureWarning = checkNetworkExposure({ ...options, apiKey })
  if (exposureWarning !== undefined) logger.warn(exposureWarning)
  const registry = createModelRegistry()

  const responsesStore = createResponsesStore()
  const vectorStores = createVectorStoresStore()
  const ephemeralFiles = createEphemeralFilesStore(undefined, {
    onEvict: (id, reason) => {
      logger.warn(`ephemeral file evicted id=${id} reason=${reason}`)
    }
  })
  const chunkAttributions = createChunkAttributionStore()
  const ffmpegAvailable = await probeFfmpegAvailable()
  if (!ffmpegAvailable) {
    logger.warn(
      'ffmpeg not on PATH — /v1/videos/{id}/content defaults to video/avi and /v1/audio/speech rejects mp3/opus/aac/flac. Install ffmpeg to serve those. See: qvac doctor'
    )
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

  // The load fn resolves the override lazily via this ref, so the manager can be
  // built before the context (loadManager is a real required field, no placeholder)
  // while tests can still swap the override post-build through the accessor below.
  const overrideRef: { current: QvacContext['loadModelOverride'] } = {
    current: options.loadModelOverride
  }
  const loadManager = createLoadManager(
    registry,
    logger,
    { concurrency: serveConfig.load.concurrency, timeoutMs: serveConfig.load.timeoutMs },
    () => overrideRef.current ?? defaultLoadFn
  )

  const qvacContext: QvacContext = {
    registry,
    serveConfig,
    loadManager,
    logger,
    vectorStores,
    ephemeralFiles,
    chunkAttributions,
    responsesStore,
    videoJobsStore,
    ffmpegAvailable,
    ...(options.transcribeOverride !== undefined
      ? { transcribeOverride: options.transcribeOverride }
      : {}),
    get loadModelOverride() {
      return overrideRef.current
    },
    set loadModelOverride(fn) {
      overrideRef.current = fn
    }
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
      servers: [{ url: `http://${options.host}:${options.port}`, description: 'this server' }],
      tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      ...(apiKey ? { security: [{ bearerAuth: [] }] } : {})
    },
    transform: jsonSchemaTransform
  })

  // lunte-disable-next-line require-await
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  if (options.docs) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true }
    })
  }

  const corsOrigins = resolveCorsOrigins(serveConfig.cors.origins, options)
  if (corsOrigins.length > 0) {
    const matchCorsOrigin = createCorsOriginMatcher(corsOrigins)
    await app.register(cors, {
      origin(origin, callback) {
        matchCorsOrigin(origin, (error, allowed) => callback(error, allowed ?? false))
      },
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

  if (apiKey) {
    await app.register(authPlugin, { apiKey })
  }

  // lunte-disable-next-line require-await
  app.addHook('onRequest', async (req) => {
    if (!isIntrospectionPath(req.url)) {
      logger.info(`→ ${req.method} ${req.url.split('?')[0]}`)
    }
    ;(req as unknown as { qvacStart: number }).qvacStart = performance.now()
  })
  // lunte-disable-next-line require-await
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

export async function startServer(options: StartServerOptions): Promise<FastifyInstance> {
  const app = await buildServer(options)

  // Resolve plugin registrations (decorators, route table) but DON'T listen
  // yet — that way the imperative preload below can use `app.qvac` while
  // keeping the port closed until models are ready, matching the pre-Fastify
  // semantics that the e2e suite depends on.
  await app.ready()
  const preload = await preloadModels(
    app.qvac.serveConfig,
    app.qvac.registry,
    app.qvac.logger,
    app.qvac.loadManager
  )
  if (shouldRefuseStart(app.qvac.serveConfig.load, preload)) {
    await app.close().catch(() => {})
    throw new Error(`All ${preload.attempted} preload model(s) failed to load; refusing to start.`)
  }
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

function isIntrospectionPath(url: string): boolean {
  return url === '/openapi.json' || url === '/docs' || url.startsWith('/docs/')
}

function resolveCorsOrigins(origins: readonly string[], options: StartServerOptions): string[] {
  const resolved = [...origins]
  if (options.docs) {
    resolved.push(
      `http://localhost:${options.port}`,
      `http://127.0.0.1:${options.port}`,
      `http://[::1]:${options.port}`
    )
    if (isLoopbackHost(options.host)) {
      const host = options.host.includes(':')
        ? `[${options.host.replace(/^\[(.*)\]$/, '$1')}]`
        : options.host
      resolved.push(`http://${host}:${options.port}`)
    }
  }
  return [...new Set(resolved.map(normalizeCorsOrigin))]
}

function logStartupSummary(app: FastifyInstance, logger: Logger): void {
  logger.info('')
  logger.info('Endpoints:')
  const routes = app
    .printRoutes({ commonPrefix: false })
    .split('\n')
    .filter((l) => l.trim().length > 0)
  for (const line of routes) {
    logger.info(`  ${line}`)
  }
  logger.info('')
}
