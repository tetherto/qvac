import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider
} from 'fastify-type-provider-zod'

import type { QvacContext } from '@/serve/core/context'
import { createCorsOriginMatcher, isLoopbackHost, normalizeCorsOrigin } from '@/serve/core/cors'
import {
  extensionErrorCodes,
  extensionSummary,
  extensionTags,
  type ServeExtension
} from '@/serve/core/extensions'
import { shutdownSDK } from '@/serve/core/lifecycle'
import authPlugin from '@/serve/core/plugins/auth'
import cancelBridgePlugin from '@/serve/core/plugins/cancel-bridge'
import contextPlugin from '@/serve/core/plugins/context'
import errorHandlerPlugin from '@/serve/core/plugins/error-handler'

const MAX_BODY_BYTES = 100 * 1024 * 1024

export interface CoreServerOptions {
  host: string
  port: number
  apiKey?: string | undefined
  docs?: boolean | undefined
  /** Trusted CORS origins from config and CLI, before the `--docs` additions. */
  corsOrigins: readonly string[]
  /** Mounted extensions, which contribute the OpenAPI description and tags. */
  extensions: readonly ServeExtension[]
}

/**
 * The shape-agnostic server: Fastify, swagger, CORS, auth, error handling and
 * request logging. It serves introspection and nothing else — routes come from
 * the extensions mounted onto it.
 */
export async function createCoreServer(
  ctx: QvacContext,
  options: CoreServerOptions
): Promise<FastifyInstance> {
  const { logger } = ctx

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: MAX_BODY_BYTES,
    ajv: { customOptions: { allErrors: false } }
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(errorHandlerPlugin, { fieldCodes: extensionErrorCodes(options.extensions) })
  await app.register(contextPlugin, { context: ctx })

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'QVAC API',
        description: extensionSummary(options.extensions),
        version: '1.0.0'
      },
      servers: [{ url: `http://${options.host}:${options.port}`, description: 'this server' }],
      tags: extensionTags(options.extensions),
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' }
        }
      },
      ...(options.apiKey ? { security: [{ bearerAuth: [] }] } : {})
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

  const corsOrigins = resolveCorsOrigins(options)
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

  await app.register(cancelBridgePlugin)

  if (options.apiKey) {
    await app.register(authPlugin, { apiKey: options.apiKey })
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

  return app as unknown as FastifyInstance
}

function isIntrospectionPath(url: string): boolean {
  return url === '/openapi.json' || url === '/docs' || url.startsWith('/docs/')
}

// Swagger UI is same-origin with the API, so `--docs` trusts the loopback
// origins a browser would actually send on that port.
function resolveCorsOrigins(options: CoreServerOptions): string[] {
  const resolved = [...options.corsOrigins]
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
