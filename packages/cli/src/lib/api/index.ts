import type { AddressInfo } from 'node:net'
import type { HttpServer } from '@/lib/http'
import { installShutdown } from './shutdown.js'

import { createLogger } from '@/lib/logger'
import type { Logger } from '@/lib/logger'
import { findConfigFile, loadConfig } from '@/lib/config'
import { parseServeConfig, unknownServeKeys } from '@/lib/api/core/config'
import { resolveServeApiKey } from '@/lib/api/core/api-key'
import { checkNetworkExposure, validateServeStartup } from '@/lib/api/core/startup'
import { createModelRegistry } from '@/lib/api/core/model-registry'
import { createEphemeralFilesStore } from '@/lib/api/core/stores/ephemeral-files'
import { createLoadManager, defaultLoadFn } from '@/lib/api/core/load-manager'
import { preloadModels, shouldRefuseStart } from '@/lib/api/core/lifecycle'
import type { QvacContext } from '@/lib/api/core/context'
import { createCoreServer } from '@/lib/api/core/server'
import { writeReadySignal } from '@/lib/api/core/ready-signal'
import {
  extensionBanners,
  extensionSummary,
  mountExtensions,
  setupExtensions,
  type ServeExtension
} from '@/lib/api/core/extensions'
import { EXTENSIONS, resolveExtensions } from '@/lib/api/extensions'

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
  /** Hostnames accepted in the Host header beyond loopback, IP literals and the bind host. */
  allowedHosts?: string[] | undefined
  /** Accept any Host header, turning off the DNS-rebinding check. */
  allowAnyHost?: boolean | undefined
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
  /** Extension names to mount. Defaults to every registered extension. */
  extensions?: string[] | undefined
  /** Per-extension options, keyed by extension name, passed to its `setup`. */
  extensionOptions?: Record<string, unknown> | undefined
  loadModelOverride?: QvacContext['loadModelOverride']
  /** Inherited descriptor that receives the bound port once the server listens. */
  readyFd?: number | undefined
}

export async function buildServer(options: StartServerOptions): Promise<HttpServer> {
  return (await buildServerParts(options)).app
}

async function buildServerParts(
  options: StartServerOptions
): Promise<{ app: HttpServer; extensions: ServeExtension[] }> {
  const logger = createLogger(options.quiet ? 'silent' : options.verbose ? 'debug' : 'info')
  const extensions = resolveExtensions(options.extensions)

  const configPath = findConfigFile(options.projectRoot, options.config)
  const rawConfig = configPath ? ((await loadConfig(configPath)) as Record<string, unknown>) : {}
  const typedConfig = rawConfig as Parameters<typeof parseServeConfig>[0]
  // Every registered extension validates its own `serve.<name>` block, whether
  // or not it is mounted.
  const serveConfig = parseServeConfig(typedConfig, options, EXTENSIONS)
  for (const key of unknownServeKeys(typedConfig, EXTENSIONS)) {
    logger.warn(`Ignoring unknown config key: serve.${key}`)
  }
  validateServeStartup(serveConfig.cors.origins, options)
  const { apiKey, warning: apiKeyWarning } = resolveServeApiKey(options)
  if (apiKeyWarning !== undefined) logger.warn(apiKeyWarning)
  // Emitted here, while options resolve, so an operator sees it before the
  // socket opens rather than after a preload that can run for minutes.
  const exposureWarning = checkNetworkExposure({ ...options, apiKey })
  if (exposureWarning !== undefined) logger.warn(exposureWarning)
  const registry = createModelRegistry()

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
    files: createEphemeralFilesStore(undefined, {
      onEvict: (id, reason) => {
        logger.warn(`ephemeral file evicted id=${id} reason=${reason}`)
      }
    }),
    extensions: {},
    get loadModelOverride() {
      return overrideRef.current
    },
    set loadModelOverride(fn) {
      overrideRef.current = fn
    }
  }

  await setupExtensions(qvacContext, extensions, options.extensionOptions ?? {})

  const app = await createCoreServer(qvacContext, {
    host: options.host,
    port: options.port,
    apiKey,
    docs: options.docs,
    corsOrigins: serveConfig.cors.origins,
    allowedHosts: serveConfig.allowedHosts,
    publicBaseUrl: serveConfig.publicBaseUrl,
    extensions
  })

  await mountExtensions(app, extensions)

  return { app, extensions }
}

export async function startServer(options: StartServerOptions): Promise<HttpServer> {
  const { app, extensions } = await buildServerParts(options)

  // Resolve plugin registrations (decorators, route table) but DON'T listen
  // yet — that way the imperative preload below can use `app.qvac` while
  // keeping the port closed until models are ready, matching the previous HTTP server
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
  for (const banner of extensionBanners(app.qvac, extensions)) {
    app.qvac.logger.warn(banner)
  }

  installShutdown(async (signal) => {
    app.log.info?.({ signal }, 'shutdown signal received')
    await app.close()
  })

  await app.listen({ port: options.port, host: options.host })
  const { port } = app.server.address() as AddressInfo
  app.qvac.logger.info(`QVAC API server listening on http://${options.host}:${port}`)
  if (options.readyFd !== undefined) {
    writeReadySignal(options.readyFd, { port, pid: process.pid })
  }
  app.qvac.logger.info(extensionSummary(extensions))
  logStartupSummary(app, app.qvac.logger)
  return app
}

function logStartupSummary(app: HttpServer, logger: Logger): void {
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
