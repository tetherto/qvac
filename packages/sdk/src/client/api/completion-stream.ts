import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { getClientLogger } from '@/logging'
import {
  completionStreamResponseSchema,
  type CompletionClientParams,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionRun,
  type CompletionStats,
  type CompletionStreamRequest,
  type McpClientInput,
  type Tool,
  type ToolCallEvent,
  type ToolCallWithCall,
  type RPCOptions
} from '@qvac/inference/surface'
import { CompletionFailedError, InferenceCancelledError } from '@/utils/errors-server'
import { getMcpToolsWithHandlers } from '@/utils/mcp-adapter'
import { validateTools, type ToolHandlerMap, type ToolInput } from '@/utils/tool-helpers'
import { buildFinalFromEvents } from '@/utils/aggregate-events'
import { generateClientRequestId } from '@/client/api/client-request-id'

const logger = getClientLogger()

type CompletionParams = Omit<CompletionClientParams, 'tools'> & {
  tools?: Tool[] | ToolInput[]
  mcp?: McpClientInput[]
  rpcOptions?: RPCOptions
  captureThinking?: boolean
  emitRawDeltas?: boolean
}

/**
 * Generates completion from a language model based on conversation history.
 */
export function completion(params: CompletionParams): CompletionRun {
  // Stable identity for this run, generated client-side so it's
  // available synchronously the moment we return — before the first
  // network round-trip and therefore before the user could possibly
  // have a "stop" handler. Surfaced on the returned `CompletionRun`
  // (`run.requestId`) so callers can `cancel({ requestId })` at any
  // point during the stream.
  const requestId = generateClientRequestId()

  let statsResolver: (value: CompletionStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  const statsPromise = new Promise<CompletionStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })

  statsPromise.catch(() => {})

  let toolCallsResolver: (value: ToolCallWithCall[]) => void = () => {}
  let toolCallsRejecter: (error: unknown) => void = () => {}
  const toolCallsPromise = new Promise<ToolCallWithCall[]>((resolve, reject) => {
    toolCallsResolver = resolve
    toolCallsRejecter = reject
  })

  toolCallsPromise.catch(() => {})

  let finalResolver: (value: CompletionFinal) => void = () => {}
  let finalRejecter: (error: unknown) => void = () => {}
  const finalPromise = new Promise<CompletionFinal>((resolve, reject) => {
    finalResolver = resolve
    finalRejecter = reject
  })

  finalPromise.catch(() => {})

  const tokenQueue: string[] = []
  const toolEventQueue: ToolCallEvent[] = []
  const eventQueue: CompletionEvent[] = []
  let done = false
  let tokenResolve: (() => void) | null = null
  let toolResolve: (() => void) | null = null
  let eventResolve: (() => void) | null = null
  let streamError: Error | null = null

  const allEvents: CompletionEvent[] = []

  function notifyWaiters() {
    if (tokenResolve) {
      tokenResolve()
      tokenResolve = null
    }
    if (toolResolve) {
      toolResolve()
      toolResolve = null
    }
    if (eventResolve) {
      eventResolve()
      eventResolve = null
    }
  }

  const processResponses = async () => {
    try {
      let allTools: Tool[] = []
      const allHandlers: ToolHandlerMap = new Map()

      if (params.tools) {
        const { tools, handlers } = validateTools(params.tools)
        allTools = tools
        for (const [name, handler] of handlers) {
          if (allHandlers.has(name)) {
            logger.warn(`Duplicate tool handler for "${name}", overwriting`)
          }
          allHandlers.set(name, handler)
        }
      }

      if (params.mcp && params.mcp.length > 0) {
        const { tools: mcpTools, handlers: mcpHandlers } = await getMcpToolsWithHandlers(params.mcp)
        allTools = [...mcpTools, ...allTools]
        for (const [name, handler] of mcpHandlers) {
          if (allHandlers.has(name)) {
            logger.warn(`Duplicate tool handler for "${name}", overwriting`)
          }
          allHandlers.set(name, handler)
        }
      }

      const request: CompletionStreamRequest = {
        type: 'completionStream',
        modelId: params.modelId,
        history: params.history.map((message) => ({ ...message, content: message.content ?? '' })),
        kvCache: params.kvCache,
        prefill: params.prefill,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: params.stream ?? true,
        generationParams: params.generationParams,
        captureThinking: params.captureThinking,
        emitRawDeltas: params.emitRawDeltas,
        toolDialect: params.toolDialect,
        responseFormat: params.responseFormat,
        requestId
      }

      const responses: AsyncGenerator<unknown> = streamRpc(request, params.rpcOptions)

      for await (const response of responses) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'completionStream'
        ) {
          const streamResponse = completionStreamResponseSchema.parse(response)

          for (const event of streamResponse.events) {
            allEvents.push(event)
            eventQueue.push(event)

            if (event.type === 'contentDelta') {
              tokenQueue.push(event.text)
            } else if (event.type === 'toolCall') {
              toolEventQueue.push(event)
            }
          }

          notifyWaiters()

          if (streamResponse.done) {
            const { final, error, cancelled } = buildFinalFromEvents(allEvents, allHandlers)
            if (error) {
              const err = new CompletionFailedError(error.message, error)
              finalRejecter(err)
              statsRejecter(err)
              toolCallsRejecter(err)
            } else if (cancelled) {
              // The wire stream ended with `stopReason: "cancelled"` — the
              // run was aborted mid-flight. Cancellation contract: `events`
              // ends normally (consumers iterating `run.events` see the
              // cancelled `completionDone` and exit naturally), and the
              // promise-aggregates reject with `InferenceCancelledError`
              // carrying whatever the aggregator accumulated up to the
              // cancel point. Consumers do `instanceof
              // InferenceCancelledError` and read `.partial.text` /
              // `.partial.toolCalls` / `.partial.stats` if they want the
              // partial output.
              const err = new InferenceCancelledError(requestId, {
                text: final.contentText,
                toolCalls: final.toolCalls,
                ...(final.stats && { stats: final.stats })
              })
              finalRejecter(err)
              statsRejecter(err)
              toolCallsRejecter(err)
            } else {
              finalResolver(final)
              statsResolver(final.stats)
              toolCallsResolver(final.toolCalls)
            }
            done = true
            notifyWaiters()
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      statsRejecter(error)
      toolCallsRejecter(error)
      finalRejecter(error)
      done = true
      notifyWaiters()
    }
  }

  void processResponses()

  const textPromise = (async () => {
    const final = await finalPromise
    return final.contentText
  })()

  textPromise.catch(() => {})

  const eventStream = (async function* () {
    while (true) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!
      } else if (done) {
        if (streamError !== null) {
          throw streamError as Error
        }
        break
      } else {
        await new Promise<void>((resolve) => {
          eventResolve = resolve
        })
      }
    }
  })()

  if (params.stream) {
    const tokenStream = (async function* () {
      while (true) {
        if (tokenQueue.length > 0) {
          yield tokenQueue.shift()!
        } else if (done) {
          if (streamError !== null) {
            throw streamError as Error
          }
          break
        } else {
          await new Promise<void>((resolve) => {
            tokenResolve = resolve
          })
        }
      }
    })()

    const toolCallStream = (async function* () {
      while (true) {
        if (toolEventQueue.length > 0) {
          yield toolEventQueue.shift()!
        } else if (done) {
          if (streamError !== null) {
            throw streamError as Error
          }
          break
        } else {
          await new Promise<void>((resolve) => {
            toolResolve = resolve
          })
        }
      }
    })()

    return {
      requestId,
      events: eventStream,
      final: finalPromise,
      tokenStream,
      toolCallStream,
      text: textPromise,
      stats: statsPromise,
      toolCalls: toolCallsPromise
    }
  } else {
    const tokenStream = (async function* () {
      //Empty generator for non-streaming mode
    })()

    const toolCallStream = (async function* () {
      //Empty generator for non-streaming mode
    })() as AsyncGenerator<ToolCallEvent>

    return {
      requestId,
      events: eventStream,
      final: finalPromise,
      tokenStream,
      toolCallStream,
      text: textPromise,
      stats: statsPromise,
      toolCalls: toolCallsPromise
    }
  }
}
