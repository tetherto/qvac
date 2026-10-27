import { handleError } from '@/lib/errors'
import { DEFAULT_EXTENSION, EXTENSIONS } from '@/lib/api/extensions'

interface ServeOptions {
  config?: string
  port: string
  host: string
  model: string[]
  apiKey?: string
  apiKeyFile?: string
  allowUnauthenticated?: boolean
  cors?: boolean
  corsOrigin: string[]
  allowedHost: string[]
  allowAnyHost?: boolean
  publicBaseUrl?: string
  docs?: boolean
  lazyLoad?: boolean
  loadConcurrency?: string
  loadTimeout?: string
  cancelLoadOnDisconnect?: boolean
  readyFd?: string
  verbose?: boolean
  /** One boolean per registered extension, plus `default` from `--no-default`. */
  [extension: string]: unknown
}

function optionalExtensions(): typeof EXTENSIONS {
  return EXTENSIONS.filter((extension) => extension.name !== DEFAULT_EXTENSION)
}

function resolveExtensionNames(options: ServeOptions): string[] {
  const names = options[DEFAULT_EXTENSION] === false ? [] : [DEFAULT_EXTENSION]
  for (const extension of optionalExtensions()) {
    if (options[extension.name] === true) names.push(extension.name)
  }
  return names
}

async function runServe(options: ServeOptions): Promise<void> {
  try {
    const { startServer } = await import('@/lib/api/index')
    await startServer({
      projectRoot: process.cwd(),
      config: options.config,
      port: parseInt(options.port, 10),
      host: options.host,
      model: options.model.length > 0 ? options.model : undefined,
      apiKey: options.apiKey,
      apiKeyFile: options.apiKeyFile,
      allowUnauthenticated: options.allowUnauthenticated,
      cors: options.cors,
      corsOrigins: options.corsOrigin.length > 0 ? options.corsOrigin : undefined,
      allowedHosts: options.allowedHost.length > 0 ? options.allowedHost : undefined,
      allowAnyHost: options.allowAnyHost,
      publicBaseUrl: options.publicBaseUrl,
      docs: options.docs,
      extensions: resolveExtensionNames(options),
      // Only forward when explicitly disabled so config can still opt out.
      lazyLoad: options.lazyLoad === false ? false : undefined,
      loadConcurrency:
        options.loadConcurrency !== undefined ? parseInt(options.loadConcurrency, 10) : undefined,
      loadTimeoutMs:
        options.loadTimeout !== undefined ? parseInt(options.loadTimeout, 10) : undefined,
      cancelLoadOnDisconnect: options.cancelLoadOnDisconnect === false ? false : undefined,
      readyFd: options.readyFd !== undefined ? Number(options.readyFd) : undefined,
      verbose: options.verbose
    })
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}

export const handler0 = runServe

export const handler1 = async (_options: ServeOptions) => {
  console.warn('`qvac sdk serve openai` is deprecated. Use `qvac sdk serve --openai --no-default`.')
  const merged = _options
  await runServe({ ...merged, openai: true, [DEFAULT_EXTENSION]: false })
}
