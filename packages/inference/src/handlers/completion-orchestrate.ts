import Buffer from 'bare-buffer'
import type {
  CompletionOrchestrateRequest,
  CompletionOrchestrateResponse,
  CompletionStreamRequest,
  CompletionStreamResponse
} from '@/schemas/index'
import { toolCallbackResultSchema, type ToolCallbackResult } from '@/schemas/completion-stream'
import type { AbortSignalLike } from '@/schemas/common'
import { aggregateEvents } from '@/utils/aggregate-events'
import { CompletionFailedError, InferenceCancelledError } from '@/errors/index'
import { dispatchPluginStream } from '@/handlers/plugin-dispatch'
import { executeToolSearch, TOOL_SEARCH_NAME } from '@/utils/tools/defer'
import { getRequestRegistry } from '@/runtime/request-context'
import { generateRandomRequestId } from '@/runtime/request-id'

const DEFAULT_MAX_TOOL_TURNS = 8

// Generous ceiling on one client-side tool execution: long enough for a slow
// MCP round trip, short enough that a client that stopped reading can't pin a
// model slot forever.
const TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000

// A single tool result is small JSON; anything past this without a newline is a
// malformed/hostile client trying to grow the buffer without bound. Fail loudly
// instead of accumulating forever.
const MAX_TOOL_RESULT_LINE_BYTES = 16 * 1024 * 1024

/**
 * Reads newline-delimited JSON tool results off the duplex request stream
 * and resolves per-callId waiters. Chunk boundaries don't align with lines,
 * so a partial tail is buffered until its newline arrives.
 *
 * The pump is torn down by `close()` (called from a `finally` when
 * orchestration ends, however it ends) so the upstream iterator is returned
 * and the reader stops holding the request stream open.
 */
export class ToolResultReader {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private readonly results = new Map<string, ToolCallbackResult>()
  private readonly waiters = new Map<string, (result: ToolCallbackResult) => void>()
  private failed: Error | undefined
  private closed = false
  private readonly iterator: AsyncIterator<Buffer>

  constructor(inputStream: AsyncIterable<Buffer>) {
    this.iterator = inputStream[Symbol.asyncIterator]()
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const next = await this.iterator.next()
        if (next.done) break
        const chunk = next.value
        let start = 0
        let nl: number
        while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
          this.append(chunk.subarray(start, nl))
          // A transport chunk can end inside a UTF-8 character. Decode complete lines only.
          const line = Buffer.concat(this.pending).toString('utf8')
          this.pending = []
          this.pendingBytes = 0
          if (line.trim()) this.accept(line)
          start = nl + 1
        }
        this.append(chunk.subarray(start))
      }
      if (!this.closed) {
        const tail = Buffer.concat(this.pending).toString('utf8')
        this.pending = []
        this.pendingBytes = 0
        if (tail.trim()) this.accept(tail)
      }
    } catch (error) {
      this.failWaiters(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private append(bytes: Uint8Array): void {
    if (this.pendingBytes + bytes.length > MAX_TOOL_RESULT_LINE_BYTES) {
      throw new CompletionFailedError('tool result frame exceeds the maximum size')
    }
    if (bytes.length) {
      this.pending.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      this.pendingBytes += bytes.length
    }
  }

  private failWaiters(error: Error): void {
    this.failed = error
    // Wake every waiter; each rethrows via waitFor's failure check.
    for (const [callId, resolve] of this.waiters) {
      this.waiters.delete(callId)
      resolve({ callId, error: error.message })
    }
  }

  private accept(line: string): void {
    const parsed = toolCallbackResultSchema.parse(JSON.parse(line))
    const waiter = this.waiters.get(parsed.callId)
    if (waiter) {
      this.waiters.delete(parsed.callId)
      waiter(parsed)
    } else {
      this.results.set(parsed.callId, parsed)
    }
  }

  /** Rejects with `InferenceCancelledError` when `signal` aborts before the result arrives. */
  async waitFor(
    callId: string,
    timeoutMs = TOOL_RESULT_TIMEOUT_MS,
    signal?: AbortSignalLike
  ): Promise<ToolCallbackResult> {
    // A cancel that landed between turns aborts the signal before the wait
    // starts; it wins over a result the client already sent.
    if (signal?.aborted) throw new InferenceCancelledError(callId)
    const buffered = this.results.get(callId)
    if (buffered) {
      this.results.delete(callId)
      return buffered
    }
    if (this.failed) throw this.failed
    return await new Promise<ToolCallbackResult>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(callId)
      }
      const onAbort = () => {
        settle()
        reject(new InferenceCancelledError(callId))
      }
      const timer = setTimeout(() => {
        settle()
        reject(new CompletionFailedError(`tool callback ${callId} timed out`))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(callId, (result) => {
        settle()
        resolve(result)
      })
    })
  }

  /**
   * Stop the pump and release the upstream iterator. Idempotent. Pending
   * waiters are failed so a caller blocked in `waitFor` can't hang after the
   * stream is torn down.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    this.results.clear()
    if (!this.failed) this.failWaiters(new CompletionFailedError('tool result stream closed'))
    void this.iterator.return?.()
  }
}

type RunTurn = (
  request: CompletionStreamRequest
) => AsyncGenerator<CompletionStreamResponse, void, unknown>

/**
 * The orchestration core, pure over its collaborators so it unit-tests
 * without the plugin registry: runs completion turns, forwards their events
 * downstream, and when a turn requests tool calls, emits `toolCallback`
 * frames and blocks on the client's results before starting the next turn
 * with the extended history.
 */
export async function* orchestrateCompletion(
  request: CompletionOrchestrateRequest,
  runTurn: RunTurn,
  reader: Pick<ToolResultReader, 'waitFor'>
): AsyncGenerator<CompletionOrchestrateResponse> {
  // Pull the loop bound out of the per-turn base; everything else (including
  // `requestId`) flows into each inner completionStream turn. Threading the
  // orchestrate `requestId` down is what makes `cancel({ requestId })` reach
  // the turn that's currently generating — the expensive part a Stop button
  // targets. Turns run strictly sequentially: turn N's request-registry entry
  // is disposed (on the `for await` break below) before turn N+1 calls
  // `begin(...)`, so reusing the id can't collide in `entries`. The handler
  // registers each tool-result wait under the same id (see
  // `registeredToolWaits`), so a cancel during the wait ends it; one that
  // lands between registrations is caught by the registry's
  // cancel-before-begin tripwire. Each turn's `history` and `type` are set below.
  const { maxToolTurns, ...turnBase } = request
  const maxTurns = maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
  let history = [...request.history]

  for (let turn = 0; turn < maxTurns; turn++) {
    const turnEvents: CompletionStreamResponse['events'] = []
    const innerRequest = {
      ...turnBase,
      history,
      type: 'completionStream'
    } as CompletionStreamRequest

    for await (const response of runTurn(innerRequest)) {
      turnEvents.push(...response.events)
      yield { type: 'completionOrchestrate', turn, events: response.events }
      if (response.done) break
    }

    const { toolCalls, rawFullText, contentText, error, cancelled } = aggregateEvents(turnEvents)

    // Terminal turn: the model answered (or failed/was cancelled) without
    // requesting tools — the client folds the forwarded events itself.
    if (error || cancelled || toolCalls.length === 0) {
      yield { type: 'completionOrchestrate', done: true }
      return
    }

    // The assistant's tool-call turn goes back verbatim so the model sees
    // its own call syntax; each result follows as a `tool` message.
    history = [...history, { role: 'assistant', content: rawFullText ?? contentText }]
    // Without a deferred tool, a `tool_search` call is the caller's own tool.
    const defers = request.tools?.some((tool) => tool.deferLoading === true) ?? false
    for (const call of toolCalls) {
      // `tool_search` is the SDK's own tool: it reads the registered inventory
      // and records what it loaded in the history, so it never leaves the worker and
      // the client is never asked to run it. The `toolCall` event still went
      // downstream with the turn's events, so the client can see it happened.
      if (defers && call.name === TOOL_SEARCH_NAME) {
        history = [
          ...history,
          {
            role: 'tool',
            content: executeToolSearch(request, call.arguments, history)
          }
        ]
        continue
      }
      yield {
        type: 'completionOrchestrate',
        turn,
        toolCallback: { callId: call.id, name: call.name, arguments: call.arguments }
      }
      let result: ToolCallbackResult
      try {
        result = await reader.waitFor(call.id)
      } catch (error) {
        if (!(error instanceof InferenceCancelledError)) throw error
        // Cancelled while the client ran its tool: end the way a cancelled
        // turn ends, so the client folds a `cancelled` stop.
        yield {
          type: 'completionOrchestrate',
          turn: turn + 1,
          events: [{ type: 'completionDone', seq: 0, stopReason: 'cancelled' }]
        }
        yield { type: 'completionOrchestrate', done: true }
        return
      }
      const content =
        result.error !== undefined
          ? JSON.stringify({ error: result.error })
          : JSON.stringify(result.result ?? null)
      history = [...history, { role: 'tool', content }]
    }
  }

  // Turn cap reached without a natural end. Emit a terminal done frame with a
  // stopReason so the client can tell this was truncated (the model still
  // wanted a tool) rather than a natural finish; the last turn's events carry
  // whatever the model produced.
  yield { type: 'completionOrchestrate', done: true, stopReason: 'maxToolTurns' }
}

/**
 * Waits for a tool result as a request of its own, under the completion's
 * `(sessionId, requestId)`, so the registry sees the completion between its
 * turns: a cancel by id or by model, the transport signal and a session close
 * stop the wait, and a session close waits for the completion to end.
 */
export function registeredToolWaits(
  reader: Pick<ToolResultReader, 'waitFor'>,
  request: Pick<CompletionOrchestrateRequest, 'requestId' | 'sessionId' | 'modelId'>
): Pick<ToolResultReader, 'waitFor'> {
  const requestId = request.requestId ?? generateRandomRequestId()
  return {
    async waitFor(callId) {
      // The model id lets `cancel({ modelId })` and an unload reach the wait.
      // An unbounded cap skips slot admission, so the wait holds none of the
      // model's completion slots while the client runs its tool.
      await using ctx = await getRequestRegistry().begin({
        requestId,
        sessionId: request.sessionId,
        kind: 'completion',
        modelId: request.modelId,
        maxConcurrentPerModel: Infinity
      })
      return await reader.waitFor(callId, undefined, ctx.signal)
    }
  }
}

export async function* handleCompletionOrchestrate(
  request: CompletionOrchestrateRequest,
  inputStream: AsyncIterable<Buffer>
): AsyncGenerator<CompletionOrchestrateResponse> {
  const reader = new ToolResultReader(inputStream)
  const runTurn: RunTurn = async function* (innerRequest) {
    yield* dispatchPluginStream<CompletionStreamRequest, CompletionStreamResponse>(
      innerRequest.modelId,
      'completionStream',
      innerRequest
    )
  }
  try {
    yield* orchestrateCompletion(request, runTurn, registeredToolWaits(reader, request))
  } finally {
    // Tear the reader down however orchestration ends -- natural finish, turn
    // cap, error, or the client abandoning the stream -- so the pump stops and
    // the request stream isn't held open.
    reader.close()
  }
}
