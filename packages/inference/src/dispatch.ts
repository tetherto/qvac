import type {
  Request,
  Response,
  RuntimeContext,
  CanonicalModelType,
  ProfilingRequestMeta,
  QvacConfig,
  RPCOptions
} from '@/schemas/index'
import {
  normalizeModelType,
  PROFILING_KEY,
  createErrorResponse,
  requestSchema
} from '@/schemas/index'
import { z } from 'zod'
import { formatZodError } from '@/utils/zod-error'
import os from 'bare-os'
import Buffer from 'bare-buffer'
import { PassThrough, type Readable } from 'bare-stream'
import { registry } from '@/registry'
import type { HandlerEntry } from '@/handlers/types'
import { handlerSupportsProgress, selectHandler } from '@/selection'
import { assertLifecycleAllowed } from '@/runtime/runtime-lifecycle'
import { resolveModelConfig, setConfig, setRuntimeContext, isConfigSet } from '@/runtime/state'
import { initialize, close as closeEngine } from '@/runtime/lifecycle'
import { getAllPlugins } from '@/plugins/index'
import { resolveConfig } from '@/config/resolve-config'
import { setGlobalLogLevel, setGlobalConsoleOutput, getAppLogger } from '@/logging/index'
import { profileReplyHandler, profileStreamHandler } from '@/profiling/index'
import {
  RPCNoHandlerError,
  PluginsNotRegisteredError,
  RequestValidationFailedError
} from '@/errors/index'

// The dispatch seam. Public operations in `api/` build a typed request and call
// `send`/`stream`/`duplex`; this runs each against the handler registry.
// A thrown handler error propagates as its real typed instance, so consumers can
// `instanceof`-check it directly.

const logger = getAppLogger()

type Handler =
  | ((req: Request, progressCallback?: (update: Response) => void) => Promise<Response> | Response)
  | ((req: Request, progressCallback?: (update: Response) => void) => AsyncGenerator<Response>)

type HandlerResult = Promise<Response> | Response | AsyncGenerator<Response>

let ready = false
let readyPromise: Promise<void> | null = null
// The current init generation. `close()` bumps it so an init still in flight
// does not mark readiness.
let generation = 0

function ensurePluginsRegistered(): void {
  if (getAllPlugins().length === 0) {
    throw new PluginsNotRegisteredError()
  }
}

function applyLoggerSettings(config: QvacConfig): void {
  if (config.loggerLevel !== undefined) setGlobalLogLevel(config.loggerLevel)
  if (config.loggerConsoleOutput !== undefined) {
    setGlobalConsoleOutput(config.loggerConsoleOutput)
  }
}

async function initializeConfig(): Promise<void> {
  // A host may have injected config already. Only resolve from disk when it hasn't
  // — a second `setConfig` would throw `ConfigAlreadySetError`.
  if (!isConfigSet()) {
    const config = await resolveConfig()
    if (config) {
      applyLoggerSettings(config)
      setConfig(config)
      logger.info('📦 Initializing QVAC config')
    }
  }
  // First-write-wins: an injected runtime context is preserved; this bare default
  // only applies to standalone Bare, where nothing was injected.
  const runtimeContext: RuntimeContext = {
    runtime: 'bare',
    platform: os.platform()
  }
  setRuntimeContext(runtimeContext)
}

async function performReady(gen: number): Promise<void> {
  initialize()
  ensurePluginsRegistered()
  await initializeConfig()
  // Mark ready only while this generation is current — a `close()` during the
  // await bumps it past this now-superseded init.
  if (gen === generation) ready = true
}

async function ensureReady(): Promise<void> {
  if (ready) return
  // A single shared promise serializes concurrent first calls: `ready` only
  // flips after `initializeConfig` awaits, so overlapping callers must run
  // `setConfig` exactly once — a second run throws `ConfigAlreadySetError`.
  // Cleared on failure so a later call can retry (e.g. after plugins register),
  // unless a newer generation already replaced this promise.
  if (!readyPromise) {
    const gen = generation
    readyPromise = performReady(gen).catch((error) => {
      if (gen === generation) readyPromise = null
      throw error
    })
  }
  await readyPromise
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

  const raw = request.modelConfig
  // Spreading a non-object would coerce it into a valid defaults object; pass it through so the schema reports the type error.
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) return request

  const rawConfig = (raw as Record<string, unknown>) ?? {}
  return { ...request, modelConfig: resolveModelConfig(canonicalType, rawConfig) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  return !Array.isArray(value)
}

function getProfilingMeta(request: Request): ProfilingRequestMeta | undefined {
  if (PROFILING_KEY in request) {
    return (request as Record<string, unknown>)[PROFILING_KEY] as ProfilingRequestMeta
  }
  return undefined
}

/**
 * Validate a request against its schema and apply device + schema defaults
 * before dispatch. Every operation flows through here, so validation and
 * defaulting are guaranteed for the whole registry — there is no per-operation
 * step to forget. Per-call profiling meta rides on a symbol key the schema
 * parse would drop, so it is carried across.
 */
function prepareRequest<T extends Request>(request: T): Request {
  let validated: Request
  let profilingMeta: ProfilingRequestMeta | undefined
  try {
    const withDeviceDefaults = applyDeviceDefaults(request)
    profilingMeta = getProfilingMeta(withDeviceDefaults)
    validated = requestSchema.parse(withDeviceDefaults)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new RequestValidationFailedError(formatZodError(error))
    }
    throw error
  }
  if (profilingMeta !== undefined) {
    ;(validated as Record<PropertyKey, unknown>)[PROFILING_KEY] = profilingMeta
  }
  return validated
}

function invokeHandler(request: Request, handler: HandlerEntry['handler']): HandlerResult {
  const directHandler = handler as Handler
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
  handler: HandlerEntry['handler']
): AsyncGenerator<Response> {
  const queue: Response[] = []
  const errors: Error[] = []
  let done = false

  function progressCallback(update: Response) {
    queue.push(update)
  }

  const directHandler = handler as Handler
  Promise.resolve(directHandler(request, progressCallback) as Promise<Response> | Response)
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
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
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

  const processed = prepareRequest(request)
  const entry = getHandlerEntry(processed.type)
  const handler = selectHandler(entry)

  // Plugin capabilities profile themselves inside plugin dispatch. Everything
  // else is timed here so the `profiler` covers every operation. Profiling is a
  // no-op unless enabled.
  if (entry.pluginOp) {
    return (await invokeHandler(processed, handler)) as Response
  }
  return profileReplyHandler(
    { op: processed.type, request: processed },
    () => invokeHandler(processed, handler) as Promise<Response>
  )
}

export async function* stream<T extends Request>(
  request: T,
  _options?: RPCOptions
): AsyncGenerator<Response> {
  await ensureReady()
  assertLifecycleAllowed(request)

  const processed = prepareRequest(request)
  const entry = getHandlerEntry(processed.type)
  const handler = selectHandler(entry)

  async function* run(): AsyncGenerator<Response> {
    if (handlerSupportsProgress(entry, processed)) {
      yield* streamWithProgress(processed, handler)
      return
    }
    const result = invokeHandler(processed, handler)
    if (isAsyncGenerator(result)) {
      yield* result
    } else {
      yield await result
    }
  }

  // See `send`: plugin capabilities are timed elsewhere.
  if (entry.pluginOp) {
    yield* run()
  } else {
    yield* profileStreamHandler({ op: processed.type, request: processed }, run)
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

  const processed = prepareRequest(request)
  const entry = registry[processed.type]
  if (!entry || entry.type !== 'duplex') {
    throw new RPCNoHandlerError(processed.type)
  }

  const inputStream = new PassThrough()
  const outputStream = new PassThrough()

  const duplexHandler = entry.handler as (
    req: Request,
    stream: Readable
  ) => AsyncGenerator<Response>

  void (async () => {
    try {
      for await (const response of duplexHandler(processed, inputStream)) {
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
  // Bump the generation so an in-flight `performReady` does not mark readiness;
  // the next send re-initializes.
  generation++
  ready = false
  readyPromise = null
  await closeEngine()
}
