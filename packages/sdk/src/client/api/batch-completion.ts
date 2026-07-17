import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { getClientLogger } from '@/logging'
import {
  batchCompletionStreamResponseSchema,
  type BatchCompletionClientParams,
  type BatchCompletionEvent,
  type BatchCompletionResult,
  type BatchCompletionRun,
  type BatchCompletionStreamRequest,
  type CompletionEvent,
  type CompletionFinal,
  type CompletionStats,
  type McpClientInput,
  type RPCOptions,
  type Tool
} from '@/schemas'
import { buildFinalFromEvents } from '@/utils/aggregate-events'
import { CompletionFailedError, InferenceCancelledError } from '@/utils/errors-server'
import { getMcpToolsWithHandlers } from '@/utils/mcp-adapter'
import { validateTools, type ToolHandlerMap, type ToolInput } from '@/utils/tool-helpers'

const logger = getClientLogger()

type BatchPromptParams = Omit<BatchCompletionClientParams['prompts'][number], 'tools'> & {
  tools?: Tool[] | ToolInput[]
  mcp?: McpClientInput[]
}

type BatchCompletionParams = Omit<BatchCompletionClientParams, 'prompts' | 'requestId'> & {
  prompts: BatchPromptParams[]
  rpcOptions?: RPCOptions
}

type BatchCompletionStreamFactory = (
  request: BatchCompletionStreamRequest,
  options?: RPCOptions
) => AsyncGenerator<unknown>

type BatchCompletionSubRun = {
  events: AsyncIterable<CompletionEvent>
  final: Promise<CompletionFinal>
}

type PerIdState = {
  allEvents: CompletionEvent[]
  final: Promise<CompletionFinal>
  finalResolver: (value: CompletionFinal) => void
  finalRejecter: (error: unknown) => void
  eventWaiters: Array<() => void>
  done: boolean
}

type ResolvedBatchPrompts = {
  prompts: BatchCompletionStreamRequest['prompts']
  handlers: ToolHandlerMap[]
}

function createPerIdState(): PerIdState {
  let finalResolver: (value: CompletionFinal) => void = () => {}
  let finalRejecter: (error: unknown) => void = () => {}
  const final = new Promise<CompletionFinal>((resolve, reject) => {
    finalResolver = resolve
    finalRejecter = reject
  })

  final.catch(() => {})

  return {
    allEvents: [],
    final,
    finalResolver,
    finalRejecter,
    eventWaiters: [],
    done: false
  }
}

function addHandlers(target: ToolHandlerMap, source: ToolHandlerMap): void {
  for (const [name, handler] of source) {
    if (target.has(name)) {
      logger.warn(`Duplicate tool handler for "${name}", overwriting`)
    }
    target.set(name, handler)
  }
}

async function resolveBatchPrompts(prompts: BatchPromptParams[]): Promise<ResolvedBatchPrompts> {
  const resolvedPrompts: BatchCompletionStreamRequest['prompts'] = []
  const resolvedHandlers: ToolHandlerMap[] = []

  for (const prompt of prompts) {
    let allTools: Tool[] = []
    const handlers: ToolHandlerMap = new Map()

    if (prompt.tools) {
      const { tools, handlers: toolHandlers } = validateTools(prompt.tools)
      allTools = tools
      addHandlers(handlers, toolHandlers)
    }

    if (prompt.mcp && prompt.mcp.length > 0) {
      const { tools: mcpTools, handlers: mcpHandlers } = await getMcpToolsWithHandlers(prompt.mcp)
      allTools = [...mcpTools, ...allTools]
      addHandlers(handlers, mcpHandlers)
    }

    resolvedHandlers.push(handlers)

    resolvedPrompts.push({
      ...(prompt.id !== undefined && { id: prompt.id }),
      history: prompt.history,
      ...(prompt.generationParams && {
        generationParams: prompt.generationParams
      }),
      ...(prompt.responseFormat && { responseFormat: prompt.responseFormat }),
      ...(allTools.length > 0 && { tools: allTools })
    })
  }

  return { prompts: resolvedPrompts, handlers: resolvedHandlers }
}

export function batchCompletion(params: BatchCompletionParams): BatchCompletionRun {
  return createBatchCompletionRun(params, streamRpc)
}

export function createBatchCompletionRun(
  params: BatchCompletionParams,
  streamFactory: BatchCompletionStreamFactory
): BatchCompletionRun {
  const requestId = generateClientRequestId()
  const states = new Map<string, PerIdState>()
  const subStreams = new Map<string, BatchCompletionSubRun>()
  const eventQueue: BatchCompletionEvent[] = []
  const handlersById = new Map<string, ToolHandlerMap>()
  let handlersByPosition: ToolHandlerMap[] = []
  const emptyHandlers: ToolHandlerMap = new Map()

  let eventResolve: (() => void) | null = null
  let idsResolver: (value: string[]) => void = () => {}
  let idsRejecter: (error: unknown) => void = () => {}
  let resultsResolver: (value: BatchCompletionResult[]) => void = () => {}
  let resultsRejecter: (error: unknown) => void = () => {}
  let statsResolver: (value: CompletionStats | undefined) => void = () => {}
  let statsRejecter: (error: unknown) => void = () => {}
  let idsResolved = false
  let done = false
  let streamError: Error | null = null
  let settledIds: Set<string> | null = null

  const idsPromise = new Promise<string[]>((resolve, reject) => {
    idsResolver = resolve
    idsRejecter = reject
  })
  idsPromise.catch(() => {})

  const resultsPromise = new Promise<BatchCompletionResult[]>((resolve, reject) => {
    resultsResolver = resolve
    resultsRejecter = reject
  })
  resultsPromise.catch(() => {})

  const statsPromise = new Promise<CompletionStats | undefined>((resolve, reject) => {
    statsResolver = resolve
    statsRejecter = reject
  })
  statsPromise.catch(() => {})

  function ensureState(id: string) {
    let state = states.get(id)
    if (!state) {
      state = createPerIdState()
      states.set(id, state)
      if (done) {
        if (streamError !== null) {
          state.finalRejecter(streamError)
          state.done = true
        } else if (settledIds?.has(id)) {
          settleState(id, state)
        } else {
          state.finalRejecter(new CompletionFailedError(`Unknown batch prompt id "${id}".`))
          state.done = true
        }
      }
    }
    return state
  }

  function notifyWaiters() {
    if (eventResolve) {
      eventResolve()
      eventResolve = null
    }
    for (const state of states.values()) {
      const waiters = state.eventWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  function resolveIds(ids: string[]) {
    if (idsResolved) return
    idsResolved = true
    for (const [index, id] of ids.entries()) {
      handlersById.set(id, handlersByPosition[index] ?? emptyHandlers)
      ensureState(id)
    }
    idsResolver(ids)
  }

  function rejectAll(error: unknown) {
    idsRejecter(error)
    resultsRejecter(error)
    statsRejecter(error)
    for (const state of states.values()) {
      if (!state.done) state.finalRejecter(error)
      state.done = true
    }
  }

  function settleState(id: string, state: PerIdState) {
    if (state.done) return undefined

    const handlers = handlersById.get(id) ?? emptyHandlers
    const { final, error, cancelled } = buildFinalFromEvents(state.allEvents, handlers)

    if (error) {
      const err = new CompletionFailedError(error.message, error)
      state.finalRejecter(err)
      state.done = true
      return err
    }

    if (cancelled) {
      const err = new InferenceCancelledError(requestId, {
        text: final.contentText,
        toolCalls: final.toolCalls,
        ...(final.stats && { stats: final.stats })
      })
      state.finalRejecter(err)
      state.done = true
      return err
    }

    state.finalResolver(final)
    state.done = true
    return { id, final }
  }

  function finishAll(ids: string[]) {
    const results: BatchCompletionResult[] = []
    let firstError: unknown
    settledIds = new Set(ids)

    for (const id of ids) {
      const state = ensureState(id)
      const outcome = settleState(id, state)
      if (outcome instanceof Error) {
        firstError ??= outcome
      } else if (outcome !== undefined) {
        results.push(outcome)
      }
    }

    for (const [id, state] of states) {
      if (!settledIds.has(id) && !state.done) {
        state.finalRejecter(new CompletionFailedError(`Unknown batch prompt id "${id}".`))
        state.done = true
      }
    }

    if (firstError !== undefined) {
      resultsRejecter(firstError)
    } else {
      resultsResolver(results)
    }

    return firstError
  }

  const processResponses = async () => {
    try {
      const resolved = await resolveBatchPrompts(params.prompts)
      handlersByPosition = resolved.handlers

      const request: BatchCompletionStreamRequest = {
        type: 'batchCompletionStream',
        modelId: params.modelId,
        prompts: resolved.prompts,
        stream: params.stream ?? true,
        captureThinking: params.captureThinking,
        emitRawDeltas: params.emitRawDeltas,
        toolDialect: params.toolDialect,
        requestId
      }

      let orderedIds: string[] = []
      const responses: AsyncGenerator<unknown> = streamFactory(request, params.rpcOptions)

      for await (const response of responses) {
        if (
          response &&
          typeof response === 'object' &&
          'type' in response &&
          response.type === 'batchCompletionStream'
        ) {
          const streamResponse = batchCompletionStreamResponseSchema.parse(response)

          if (streamResponse.ids) {
            orderedIds = streamResponse.ids
            resolveIds(orderedIds)
          }

          for (const batchEvent of streamResponse.events) {
            const state = ensureState(batchEvent.id)
            state.allEvents.push(batchEvent.event)
            eventQueue.push(batchEvent)
          }

          notifyWaiters()

          if (streamResponse.done) {
            if (!idsResolved) {
              orderedIds =
                orderedIds.length > 0
                  ? orderedIds
                  : params.prompts.map((prompt, index) => prompt.id ?? String(index))
              resolveIds(orderedIds)
            }
            const firstError = finishAll(orderedIds)
            if (firstError !== undefined) {
              statsRejecter(firstError)
            } else {
              statsResolver(streamResponse.stats)
            }
            done = true
            notifyWaiters()
          }
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error))
      rejectAll(error)
      done = true
      for (const state of states.values()) state.done = true
      notifyWaiters()
    }
  }

  void processResponses()

  const events = (async function* () {
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

  function makeSubStream(id: string): BatchCompletionSubRun {
    const state = ensureState(id)
    const events = {
      async *[Symbol.asyncIterator]() {
        let index = 0
        while (true) {
          if (index < state.allEvents.length) {
            yield state.allEvents[index]!
            index += 1
          } else if (state.done || done) {
            if (streamError !== null) {
              throw streamError
            }
            break
          } else {
            await new Promise<void>((resolve) => {
              state.eventWaiters.push(resolve)
            })
          }
        }
      }
    }

    return {
      events,
      final: state.final
    }
  }

  function byId(id: string) {
    let subStream = subStreams.get(id)
    if (!subStream) {
      subStream = makeSubStream(id)
      subStreams.set(id, subStream)
    }
    return subStream
  }

  return {
    requestId,
    ids: idsPromise,
    events,
    results: resultsPromise,
    stats: statsPromise,
    byId
  }
}
