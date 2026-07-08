import type {
  Request,
  Response,
  RuntimeContext,
  CanonicalModelType,
  ProfilingRequestMeta,
  QvacConfig,
  RPCOptions
} from './schemas'
import { normalizeModelType, PROFILING_KEY, createErrorResponse } from './schemas'
import os from 'bare-os'
import Buffer from 'bare-buffer'
import { PassThrough, type Readable } from 'bare-stream'
import { registry } from './engine/registry'
import type { HandlerEntry } from './engine/handler-utils'
import { handlerSupportsProgress, selectHandler } from './engine/selection'
import { assertLifecycleAllowed } from './engine/runtime-lifecycle'
import { resolveModelConfig } from './engine/state/model-config-registry'
import { setSDKConfig } from './engine/state/config-registry'
import { setRuntimeContext } from './engine/state/runtime-context-registry'
import { initialize, close as closeEngine } from './engine/lifecycle'
import { getAllPlugins } from './plugins'
import { resolveConfig } from './config/resolve-config'
import { setGlobalLogLevel, setGlobalConsoleOutput, getClientLogger } from './logging'
import { RPCNoHandlerError, PluginsNotRegisteredError } from './errors'

// The dispatch seam. Public operations in `api/` build a typed request and call
// `send`/`stream`/`duplex`; this runs each against the engine's handler registry.
// A thrown handler error propagates as its real typed instance, so consumers can
// `instanceof`-check it directly.

const logger = getClientLogger()

type Handler =
  | ((
      req: Request,
      arg?: ((update: Response) => void) | DelegatedOptions
    ) => Promise<Response> | Response)
  | ((
      req: Request,
      arg?: ((update: Response) => void) | DelegatedOptions
    ) => AsyncGenerator<Response>)

type HandlerResult = Promise<Response> | Response | AsyncGenerator<Response>

interface DelegatedOptions {
  progressCallback?: (update: Response) => void
  profilingMeta?: ProfilingRequestMeta
}

let ready = false

function ensurePluginsRegistered(): void {
  if (getAllPlugins().length === 0) {
    throw new PluginsNotRegisteredError()
  }
}

function applyClientLoggerSettings(config: QvacConfig): void {
  if (config.loggerLevel !== undefined) setGlobalLogLevel(config.loggerLevel)
  if (config.loggerConsoleOutput !== undefined) {
    setGlobalConsoleOutput(config.loggerConsoleOutput)
  }
}

async function initializeConfig(): Promise<void> {
  const config = await resolveConfig()
  if (config) {
    applyClientLoggerSettings(config)
    setSDKConfig(config)
    logger.info('📦 Initializing QVAC config')
  }
  const runtimeContext: RuntimeContext = {
    runtime: 'bare',
    platform: os.platform()
  }
  setRuntimeContext(runtimeContext)
}

async function ensureReady(): Promise<void> {
  if (ready) return
  initialize()
  ensurePluginsRegistered()
  await initializeConfig()
  ready = true
}

function getHandlerEntry(type: string): HandlerEntry {
  const entry = registry[type]
  if (!entry) throw new RPCNoHandlerError(type)
  return entry
}

/**
 * Fill loadModel requests with device + schema config defaults before the
 * handler runs, matching the priority user config > device defaults > schema
 * defaults. Other request types pass through untouched.
 */
function applyDeviceDefaults<T extends Request>(request: T): T {
  if (request.type !== 'loadModel' || !('modelSrc' in request)) return request

  let canonicalType: CanonicalModelType
  try {
    canonicalType = normalizeModelType(request.modelType) as CanonicalModelType
  } catch {
    return request
  }

  const rawConfig = (request.modelConfig as Record<string, unknown>) ?? {}
  return { ...request, modelConfig: resolveModelConfig(canonicalType, rawConfig) }
}

function getProfilingMeta(request: Request): ProfilingRequestMeta | undefined {
  if (PROFILING_KEY in request) {
    return (request as Record<string, unknown>)[PROFILING_KEY] as ProfilingRequestMeta
  }
  return undefined
}

function delegatedOptions(
  request: Request,
  progressCallback?: (update: Response) => void
): DelegatedOptions | undefined {
  const profilingMeta = getProfilingMeta(request)
  if (!profilingMeta && !progressCallback) return undefined
  const options: DelegatedOptions = {}
  if (progressCallback) options.progressCallback = progressCallback
  if (profilingMeta) options.profilingMeta = profilingMeta
  return options
}

function invokeHandler(
  request: Request,
  handler: HandlerEntry['handler'],
  isDelegated: boolean
): HandlerResult {
  const directHandler = handler as Handler
  if (isDelegated) return directHandler(request, delegatedOptions(request))
  return directHandler(request)
}

function isAsyncGenerator(result: HandlerResult): result is AsyncGenerator<Response> {
  return typeof result === 'object' && result !== null && Symbol.asyncIterator in result
}

/**
 * Bridge a progress-callback handler (which returns a single final response and
 * pushes interim updates through a callback) into an async generator.
 */
async function* streamWithProgress(
  request: Request,
  handler: HandlerEntry['handler'],
  isDelegated: boolean
): AsyncGenerator<Response> {
  const queue: Response[] = []
  const errors: Error[] = []
  let done = false

  function progressCallback(update: Response) {
    queue.push(update)
  }

  const directHandler = handler as Handler
  Promise.resolve(
    directHandler(
      request,
      isDelegated ? delegatedOptions(request, progressCallback) : progressCallback
    ) as Promise<Response> | Response
  )
    .then((final) => {
      queue.push(final)
      done = true
    })
    .catch((error: Error) => {
      errors.push(error)
      done = true
    })

  while (!done || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const handlerError = errors[0]
  if (handlerError) throw handlerError
}

export async function send<T extends Request>(
  request: T,
  _options?: RPCOptions
): Promise<Response> {
  await ensureReady()
  assertLifecycleAllowed(request)

  const processed = applyDeviceDefaults(request)
  const entry = getHandlerEntry(processed.type)
  const { handler, isDelegated } = selectHandler(entry, processed)
  return (await invokeHandler(processed, handler, isDelegated)) as Response
}

export async function* stream<T extends Request>(
  request: T,
  _options?: RPCOptions
): AsyncGenerator<Response> {
  await ensureReady()
  assertLifecycleAllowed(request)

  const processed = applyDeviceDefaults(request)
  const entry = getHandlerEntry(processed.type)
  const { handler, isDelegated } = selectHandler(entry, processed)

  if (handlerSupportsProgress(entry, processed)) {
    yield* streamWithProgress(processed, handler, isDelegated)
    return
  }

  const result = invokeHandler(processed, handler, isDelegated)
  if (isAsyncGenerator(result)) {
    yield* result
  } else {
    yield await result
  }
}

export interface DuplexWritable {
  write(chunk: Uint8Array): void
  end(): void
  destroy(): void
}

export interface DuplexReadable extends AsyncIterable<Buffer | string> {
  destroy(): void
}

export interface DuplexSession {
  requestStream: DuplexWritable
  responseStream: DuplexReadable
}

export async function duplex<T extends Request>(
  request: T,
  _options?: RPCOptions
): Promise<DuplexSession> {
  await ensureReady()
  assertLifecycleAllowed(request)

  const entry = registry[request.type]
  if (!entry || entry.type !== 'duplex') {
    throw new RPCNoHandlerError(request.type)
  }

  const inputStream = new PassThrough()
  const outputStream = new PassThrough()

  const duplexHandler = entry.handler as (
    req: Request,
    stream: Readable
  ) => AsyncGenerator<Response>

  void (async () => {
    try {
      for await (const response of duplexHandler(request, inputStream)) {
        outputStream.write(JSON.stringify(response) + '\n', 'utf-8')
      }
    } catch (error) {
      inputStream.destroy()
      outputStream.write(JSON.stringify(createErrorResponse(error)) + '\n', 'utf-8')
    } finally {
      outputStream.end()
    }
  })()

  return {
    requestStream: inputStream,
    responseStream: outputStream as unknown as DuplexReadable
  }
}

export async function close(): Promise<void> {
  ready = false
  await closeEngine()
}
