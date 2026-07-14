import { PROFILING_KEY, type Request, type ProfilingRequestMeta } from '@qvac/core/surface'
import { nowMs } from '@qvac/core/surface'
import { send, stream, duplex, dispatchTransport } from '@qvac/core/engine'
import type RPC from 'bare-rpc'
import { sendErrorResponse, sendStreamErrorResponse } from '@/server/error-handlers'
import { PluginHandlerTypeMismatchError } from '@/utils/errors-server'
import {
  handleInitConfig,
  isInitConfigMessage,
  handleShutdown,
  isShutdownMessage
} from './handler-utils'
import { createServerProfiler, type ServerProfiler } from '@/server/rpc/profiling'
import { isTerminalChunk } from '@/server/rpc/rpc-utils'

type Transport = 'reply' | 'stream' | 'duplex' | undefined

export async function handleRequest(req: RPC.IncomingRequest): Promise<void> {
  let profiler: ServerProfiler | undefined
  let transport: Transport

  try {
    const rawData = req.data?.toString()

    // Duplex stream request: metadata arrives as the first chunk on the
    // request stream (client used createRequestStream instead of send).
    if (!rawData) {
      await handleDuplexRequest(req)
      return
    }

    // Timing runs unconditionally since we can't know if the client
    // requested profiling until after parsing.
    const parseStart = nowMs()
    const jsonData: unknown = JSON.parse(rawData)
    const jsonParseMs = nowMs() - parseStart

    // Internal control messages bypass the engine.
    if (isInitConfigMessage(jsonData)) {
      handleInitConfig(req, jsonData)
      return
    }
    if (isShutdownMessage(jsonData)) {
      await handleShutdown(req)
      return
    }

    const { data: cleanData, profilingMeta } = extractProfilingMeta(jsonData)
    profiler = createServerProfiler(profilingMeta)
    profiler.markRequestParsed(jsonParseMs)

    // The engine validates, defaults, and gates the request; the worker only
    // frames the reply. Profiling meta rides on a symbol key the engine reads.
    const request = cleanData as Request
    attachProfilingMetaToRequest(request, profilingMeta)
    transport = dispatchTransport(request)

    if (transport === 'stream') {
      await streamToWire(req, request, profiler)
    } else if (transport === 'duplex') {
      throw new PluginHandlerTypeMismatchError(request.type, 'reply or stream', 'duplex')
    } else {
      profiler.startHandler()
      const response = await send(request)
      profiler.endHandler()
      req.reply(profiler.serialize(response, true), 'utf-8')
    }
  } catch (error) {
    if (transport === 'stream') {
      sendStreamErrorResponse(req.createResponseStream(), error, profiler)
    } else {
      sendErrorResponse(req, error, profiler)
    }
  }
}

async function streamToWire(
  req: RPC.IncomingRequest,
  request: Request,
  profiler: ServerProfiler
): Promise<void> {
  const wire = req.createResponseStream()
  profiler.startHandler()
  let sentFinalChunk = false

  try {
    for await (const response of stream(request)) {
      if (isTerminalChunk(response)) {
        profiler.endHandler()
        wire.write(profiler.serialize(response, true) + '\n', 'utf-8')
        sentFinalChunk = true
      } else {
        wire.write(profiler.serialize(response, false) + '\n', 'utf-8')
      }
    }

    if (!sentFinalChunk) {
      profiler.endHandler()
      const trailer = profiler.serialize()
      if (trailer) {
        wire.write(trailer + '\n', 'utf-8')
      }
    }

    wire.end()
  } catch (error) {
    profiler.endHandler()
    sendStreamErrorResponse(wire, error, profiler)
  }
}

async function handleDuplexRequest(req: RPC.IncomingRequest): Promise<void> {
  const rpcInput = req.createRequestStream()
  const rpcOutput = req.createResponseStream()
  let profiler: ServerProfiler | undefined

  try {
    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (data: unknown) => {
        rpcInput.off('error', onError)
        rpcInput.pause()
        resolve(data as Buffer)
      }
      const onError = (err: unknown) => {
        rpcInput.off('data', onData)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      rpcInput.once('data', onData)
      rpcInput.once('error', onError)
    })

    const parseStart = nowMs()
    const jsonData: unknown = JSON.parse(firstChunk.toString())
    const jsonParseMs = nowMs() - parseStart

    const { data: cleanData, profilingMeta } = extractProfilingMeta(jsonData)
    profiler = createServerProfiler(profilingMeta)
    profiler.markRequestParsed(jsonParseMs)

    const request = cleanData as Request
    attachProfilingMetaToRequest(request, profilingMeta)

    const session = await duplex(request)

    // Feed the remaining RPC input into the engine's input stream, and forward
    // the engine's newline-framed responses back out to the wire.
    rpcInput.on('data', (chunk: unknown) => session.requestStream.write(chunk as Uint8Array))
    rpcInput.on('end', () => session.requestStream.end())
    rpcInput.on('error', () => session.requestStream.destroy())
    rpcInput.resume()

    profiler.startHandler()
    for await (const chunk of session.responseStream) {
      rpcOutput.write(chunk, 'utf-8')
    }
    profiler.endHandler()

    // Emit the profiler trailer on its own line after core's newline-framed
    // responses, so the client's duplexProfiled sees server metadata like the
    // reply and stream paths do.
    const trailer = profiler.serialize()
    if (trailer) {
      rpcOutput.write(trailer + '\n', 'utf-8')
    }
    rpcOutput.end()
  } catch (error) {
    rpcInput.destroy()
    sendStreamErrorResponse(rpcOutput, error, profiler)
  }
}

function attachProfilingMetaToRequest(
  request: Request,
  profilingMeta?: ProfilingRequestMeta
): void {
  if (!profilingMeta) return

  Object.defineProperty(request, PROFILING_KEY, {
    value: profilingMeta,
    enumerable: false,
    configurable: true,
    writable: false
  })
}

function extractProfilingMeta(data: unknown): {
  data: unknown
  profilingMeta: ProfilingRequestMeta | undefined
} {
  if (!data || typeof data !== 'object' || !(PROFILING_KEY in data)) {
    return { data, profilingMeta: undefined }
  }

  const obj = data as Record<string, unknown>
  const { [PROFILING_KEY]: meta, ...rest } = obj

  return {
    data: rest,
    profilingMeta: meta as ProfilingRequestMeta | undefined
  }
}
