import createHttpServer, { type HttpServer } from '@/lib/http'
import { z } from 'zod'
import { apiDocsHtml } from '@/lib/api/core/docs'

import type { QvacContext } from '@/lib/api/core/context'
import { createCorsOriginMatcher, isLoopbackHost, normalizeCorsOrigin } from '@/lib/api/core/cors'
import {
  extensionErrorCodes,
  extensionSummary,
  extensionTags,
  type ServeExtension
} from '@/lib/api/core/extensions'
import { createHostMatcher } from '@/lib/api/core/host-check'
import { IDENTITY_NONCE_PATTERN, IDENTITY_PATH, identityProof } from '@/lib/api/core/identity'
import { shutdownSDK } from '@/lib/api/core/lifecycle'
import authPlugin from '@/lib/api/core/plugins/auth'
import cancelBridgePlugin from '@/lib/api/core/plugins/cancel-bridge'
import contextPlugin from '@/lib/api/core/plugins/context'
import errorHandlerPlugin from '@/lib/api/core/plugins/error-handler'
import { HttpError } from '@/lib/api/lib/http-error'

const MAX_BODY_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_FILES = 10

export interface CoreServerOptions {
  host: string
  port: number
  apiKey?: string | undefined
  docs?: boolean | undefined
  /** Trusted CORS origins from config and CLI, before the `--docs` additions. */
  corsOrigins: readonly string[]
  /** Hostnames accepted in the Host header beyond loopback, IP literals and the bind host; `true` accepts any. */
  allowedHosts: readonly string[] | true
  publicBaseUrl?: string | null | undefined
  /** Mounted extensions, which contribute the OpenAPI description and tags. */
  extensions: readonly ServeExtension[]
}

/**
 * The HTTP server: OpenAPI, CORS, auth, error handling and
 * request logging. It serves introspection and nothing else — routes come from
 * the extensions mounted onto it.
 */
export async function createCoreServer(
  ctx: QvacContext,
  options: CoreServerOptions
): Promise<HttpServer> {
  const { logger } = ctx

  const app = createHttpServer({
    bodyLimit: MAX_BODY_BYTES,
    multipart: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES }
  })

  await errorHandlerPlugin(app, { fieldCodes: extensionErrorCodes(options.extensions) })
  await contextPlugin(app, { context: ctx })

  // Binding to loopback does not stop a page whose own hostname now resolves to
  // 127.0.0.1 (DNS rebinding): its requests are same-origin, so CORS never applies.
  const hostAllowed = createHostMatcher({
    bindHost: options.host,
    allowedHosts: options.allowedHosts,
    publicBaseUrl: options.publicBaseUrl
  })
  // lunte-disable-next-line require-await
  app.addHook('onRequest', async (req) => {
    if (!hostAllowed(req.headers['host'])) {
      throw new HttpError(
        403,
        'host_not_allowed',
        'Host header is not allowed. Add it with --allowed-host or serve.allowedHosts.'
      )
    }
  })

  app.setOpenApiDocument({
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
  })

  // lunte-disable-next-line require-await
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  if (options.docs) {
    const docs = async (_req: unknown, reply: import('@/lib/http').HttpReply) =>
      reply.type('text/html; charset=utf-8').send(apiDocsHtml)
    app.get('/docs', { schema: { hide: true } }, docs)
    app.get('/docs/', { schema: { hide: true } }, docs)
    app.get('/docs/json', { schema: { hide: true } }, async () => app.swagger())
  }

  const corsOrigins = resolveCorsOrigins(options)
  if (corsOrigins.length > 0) {
    const matchCorsOrigin = createCorsOriginMatcher(corsOrigins)
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers['origin']
      reply.header('vary', 'Origin')
      const allowed = await new Promise<boolean>((resolve, reject) => {
        matchCorsOrigin(origin, (error, match) => (error ? reject(error) : resolve(match ?? false)))
      })
      if (origin && allowed) {
        reply.header('access-control-allow-origin', origin)
        if (req.method === 'OPTIONS') {
          reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
          reply.header('access-control-allow-headers', 'Content-Type, Authorization')
        }
      }
      if (req.method === 'OPTIONS') reply.code(204).send()
    })
  }

  await cancelBridgePlugin(app, {})

  if (options.apiKey) {
    const apiKey = options.apiKey
    await authPlugin(app, { apiKey })
    app.get(
      IDENTITY_PATH,
      {
        schema: {
          hide: true,
          querystring: z.object({ nonce: z.string().regex(IDENTITY_NONCE_PATTERN) })
        }
      },
      // lunte-disable-next-line require-await
      async (req) => ({ proof: identityProof(apiKey, req.query.nonce, req.socket.localPort ?? 0) })
    )
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

  // startServer preloads models before listening; downloads may take minutes.
  app.addHook('onClose', async () => {
    await shutdownSDK(logger)
  })

  return app
}

function isIntrospectionPath(url: string): boolean {
  return url === '/openapi.json' || url === '/docs' || url.startsWith('/docs/')
}

// API explorer is same-origin with the API, so `--docs` trusts the loopback
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
