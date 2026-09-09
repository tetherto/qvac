import type { LoadConfig, ServeConfig, ServeExtensionConfig } from '@/serve/core/config/types'
import { resolveDefaults, resolveServeModels, type RawModelEntry } from '@/serve/core/config/models'
import type { ServeExtension } from '@/serve/core/extensions'
import { normalizeCorsOrigin } from '@/serve/core/cors'

interface RawServeConfig {
  serve?: {
    models?: Record<string, RawModelEntry>
    publicBaseUrl?: string
    cors?: {
      origins?: unknown
    }
    load?: RawLoadConfig
    /** `serve.<extension>` blocks; each extension parses its own. */
    [extension: string]: unknown
  }
}

interface RawLoadConfig {
  lazy?: unknown
  concurrency?: unknown
  timeoutMs?: unknown
  cancelOnDisconnect?: unknown
}

interface CLIServeOptions {
  model?: string | string[] | undefined
  publicBaseUrl?: string | undefined
  corsOrigins?: string[] | undefined
  lazyLoad?: boolean | undefined
  loadConcurrency?: number | undefined
  loadTimeoutMs?: number | null | undefined
  cancelLoadOnDisconnect?: boolean | undefined
}

export function parseServeConfig(
  rawConfig: RawServeConfig,
  cliOptions: CLIServeOptions,
  extensions: readonly ServeExtension[] = []
): ServeConfig {
  const serve = rawConfig.serve ?? {}
  const models = resolveServeModels(serve.models ?? {})

  if (cliOptions.model) {
    const cliModels = Array.isArray(cliOptions.model) ? cliOptions.model : [cliOptions.model]
    for (const alias of cliModels) {
      const entry = models.get(alias)
      if (entry) {
        entry.preload = true
      }
    }
  }

  return {
    models,
    defaults: resolveDefaults(models),
    load: parseLoadConfig(serve.load, cliOptions),
    publicBaseUrl: normalizePublicBaseUrl(cliOptions.publicBaseUrl ?? serve.publicBaseUrl),
    cors: { origins: parseCorsOrigins(serve.cors?.origins, cliOptions.corsOrigins) },
    extensions: parseExtensionConfigs(serve, extensions)
  }
}

const CORE_SERVE_KEYS = ['models', 'publicBaseUrl', 'cors', 'load']

/** `serve.*` keys that belong to neither core nor a registered extension. */
export function unknownServeKeys(
  rawConfig: RawServeConfig,
  extensions: readonly ServeExtension[]
): string[] {
  const known = new Set([...CORE_SERVE_KEYS, ...extensions.map((e) => e.name)])
  return Object.keys(rawConfig.serve ?? {}).filter((key) => !known.has(key))
}

// Every registered extension parses its block whether or not it is mounted, so
// a typo in `serve.<extension>` fails at startup rather than lying dormant.
function parseExtensionConfigs(
  serve: Record<string, unknown>,
  extensions: readonly ServeExtension[]
): Partial<ServeExtensionConfig> {
  const parsed: Record<string, unknown> = {}
  for (const extension of extensions) {
    if (extension.parseConfig === undefined) continue
    parsed[extension.name] = extension.parseConfig(serve[extension.name])
  }
  return parsed as Partial<ServeExtensionConfig>
}

const DEFAULT_LOAD_CONCURRENCY = 1

function parseLoadConfig(raw: RawLoadConfig | undefined, cli: CLIServeOptions): LoadConfig {
  const lazy = cli.lazyLoad ?? asBoolean(raw?.lazy, 'serve.load.lazy') ?? true
  const cancelOnDisconnect =
    cli.cancelLoadOnDisconnect ??
    asBoolean(raw?.cancelOnDisconnect, 'serve.load.cancelOnDisconnect') ??
    true

  const concurrency =
    asPositiveInt(cli.loadConcurrency, '--load-concurrency') ??
    asPositiveInt(raw?.concurrency, 'serve.load.concurrency') ??
    DEFAULT_LOAD_CONCURRENCY

  let timeoutMs: number | null
  if (cli.loadTimeoutMs !== undefined) {
    timeoutMs =
      cli.loadTimeoutMs === null
        ? null
        : (asPositiveInt(cli.loadTimeoutMs, '--load-timeout') ?? null)
  } else {
    timeoutMs = asPositiveInt(raw?.timeoutMs, 'serve.load.timeoutMs') ?? null
  }

  return { lazy, concurrency, timeoutMs, cancelOnDisconnect }
}

function asBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function asPositiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} must be a positive integer`)
  }
  return value
}

function parseCorsOrigins(configured: unknown, cliOrigins: string[] | undefined): string[] {
  if (configured !== undefined && !Array.isArray(configured)) {
    throw new Error('serve.cors.origins must be an array of HTTP(S) origins')
  }

  const origins = [...(configured ?? []), ...(cliOrigins ?? [])] as unknown[]
  const normalized = origins.map((origin, index) => {
    if (typeof origin !== 'string') {
      throw new Error(`serve.cors.origins[${index}] must be a string`)
    }
    return normalizeCorsOrigin(origin)
  })

  return [...new Set(normalized)]
}

function normalizePublicBaseUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`serve.publicBaseUrl must start with http:// or https:// (got "${trimmed}").`)
  }
  return trimmed.replace(/\/+$/, '')
}
