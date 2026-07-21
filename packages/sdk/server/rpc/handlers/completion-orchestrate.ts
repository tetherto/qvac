import type {
  CompletionOrchestrateRequest,
  CompletionOrchestrateResponse,
  CompletionStreamRequest,
  CompletionStreamResponse
} from '@/schemas'
import { toolCallbackResultSchema, type ToolCallbackResult } from '@/schemas/completion-stream'
import { aggregateEvents } from '@/utils/aggregate-events'
import { CompletionFailedError } from '@/utils/errors-server'
import { dispatchPluginStream } from '@/server/rpc/handlers/plugin-dispatch'

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
  private buffer = ''
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
        this.buffer += next.value.toString()
        let nl: number
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl)
          this.buffer = this.buffer.slice(nl + 1)
          if (line.trim()) this.accept(line)
        }
        if (this.buffer.length > MAX_TOOL_RESULT_LINE_BYTES) {
          throw new CompletionFailedError('tool result frame exceeds the maximum size')
        }
      }
      if (!this.closed && this.buffer.trim()) this.accept(this.buffer)
    } catch (error) {
      this.failWaiters(error instanceof Error ? error : new Error(String(error)))
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

  async waitFor(callId: string, timeoutMs = TOOL_RESULT_TIMEOUT_MS): Promise<ToolCallbackResult> {
    const buffered = this.results.get(callId)
    if (buffered) {
      this.results.delete(callId)
      return buffered
    }
    if (this.failed) throw this.failed
    return await new Promise<ToolCallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(callId)
        reject(new CompletionFailedError(`tool callback ${callId} timed out`))
      }, timeoutMs)
      this.waiters.set(callId, (result) => {
        clearTimeout(timer)
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
    this.buffer = ''
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
  // `begin(...)`, so reusing the id can't collide in `entries`. A cancel that
  // lands between turns (during a tool-result wait) is caught by the
  // registry's cancel-before-begin tripwire and aborts the next turn's
  // `begin(...)`. Each turn's `history` and `type` are set below.
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
    for (const call of toolCalls) {
      yield {
        type: 'completionOrchestrate',
        turn,
        toolCallback: { callId: call.id, name: call.name, arguments: call.arguments }
      }
      const result = await reader.waitFor(call.id)
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
    yield* orchestrateCompletion(request, runTurn, reader)
  } finally {
    // Tear the reader down however orchestration ends -- natural finish, turn
    // cap, error, or the client abandoning the stream -- so the pump stops and
    // the request stream isn't held open.
    reader.close()
  }
}
