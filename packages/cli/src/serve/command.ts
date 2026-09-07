import type { Command } from 'commander'
import { collect } from '@/cli/options'
import { handleError } from '@/errors'
import { DEFAULT_EXTENSION, EXTENSIONS } from '@/serve/extensions'

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
  publicBaseUrl?: string
  docs?: boolean
  lazyLoad?: boolean
  loadConcurrency?: string
  loadTimeout?: string
  cancelLoadOnDisconnect?: boolean
  verbose?: boolean
  /** One boolean per registered extension, plus `default` from `--no-default`. */
  [extension: string]: unknown
}

export function registerServeCommand(program: Command): void {
  const serveCmd = program
    .command('serve')
    .description('Start an API server backed by QVAC')
    .option('--no-default', `Do not mount the ${DEFAULT_EXTENSION} surface`)

  for (const extension of optionalExtensions()) {
    serveCmd.option(`--${extension.name}`, `Mount the ${extension.description}`)
  }

  addServeOptions(serveCmd).action(runServe)

  // Options are declared on both `serve` and this alias so they still show in
  // `serve openai --help`, but commander routes the values to `serve`, so the
  // handler reads the merged view rather than its own (defaults-only) opts.
  addServeOptions(
    serveCmd
      .command('openai')
      .description(
        'Deprecated: start the OpenAI-compatible REST API server with `qvac serve --openai --no-default`'
      )
  ).action(async (_options: ServeOptions, command: Command) => {
    console.warn('`qvac serve openai` is deprecated. Use `qvac serve --openai --no-default`.')
    const merged = command.optsWithGlobals() as ServeOptions
    await runServe({ ...merged, openai: true, [DEFAULT_EXTENSION]: false })
  })
}

/** Every extension a flag can mount; the default one is always mounted instead. */
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

function addServeOptions(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Config file path (default: auto-detect qvac.config.*)')
    .option('-p, --port <number>', 'Port to listen on', '11434')
    .option('-H, --host <address>', 'Host to bind to', '127.0.0.1')
    .option(
      '--model <alias>',
      'Model alias to preload (repeatable, must be in config)',
      collect,
      []
    )
    .option('--api-key <key>', 'Require Bearer token authentication')
    .option(
      '--api-key-file <path>',
      'Read the Bearer token from a file instead of argv (keeps it out of the process list)'
    )
    .option('--allow-unauthenticated', 'Permit binding to a non-loopback host without an API key')
    .option('--cors', 'Validate that explicit trusted CORS origins are configured')
    .option('--cors-origin <origin>', 'Trusted CORS origin (repeatable)', collect, [])
    .option(
      '--public-base-url <url>',
      'Externally reachable origin (required for image response_format=url)'
    )
    .option(
      '--docs',
      'Expose Swagger UI at /docs and add same-port loopback CORS origins; requires a fixed --port (JSON spec is always at /openapi.json)'
    )
    .option(
      '--no-lazy-load',
      'Disable lazy loading; a request for an unloaded model returns 503 model_not_loaded instead of loading it'
    )
    .option('--load-concurrency <n>', 'Max simultaneous model loads (default: 1)')
    .option('--load-timeout <ms>', 'Per-load timeout in milliseconds (default: unbounded)')
    .option(
      '--no-cancel-load-on-disconnect',
      'Keep loading a model even if the client that triggered the load disconnects'
    )
    .option('-v, --verbose', 'Detailed output')
}

async function runServe(options: ServeOptions): Promise<void> {
  try {
    const { startServer } = await import('@/serve/index')
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
      verbose: options.verbose
    })
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
