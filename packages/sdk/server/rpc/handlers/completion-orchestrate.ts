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

/**
 * Reads newline-delimited JSON tool results off the duplex request stream
 * and resolves per-callId waiters. Chunk boundaries don't align with lines,
 * so a partial tail is buffered until its newline arrives.
 */
export class ToolResultReader {
  private buffer = ''
  private readonly results = new Map<string, ToolCallbackResult>()
  private readonly waiters = new Map<string, (result: ToolCallbackResult) => void>()
  private failed: Error | undefined

  constructor(inputStream: AsyncIterable<Buffer>) {
    void this.pump(inputStream)
  }

  private async pump(inputStream: AsyncIterable<Buffer>): Promise<void> {
    try {
      for await (const chunk of inputStream) {
        this.buffer += chunk.toString()
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) this.accept(line)
        }
      }
      if (this.buffer.trim()) this.accept(this.buffer)
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error))
      // Wake every waiter; each rethrows via waitFor's failure check.
      for (const [callId, resolve] of this.waiters) {
        this.waiters.delete(callId)
        resolve({ callId, error: this.failed.message })
      }
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
  const maxTurns = request.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS
  const { type: _type, maxToolTurns: _cap, requestId: _rid, ...base } = request
  void _type
  void _cap
  void _rid
  let history = [...request.history]

  for (let turn = 0; turn < maxTurns; turn++) {
    const turnEvents: CompletionStreamResponse['events'] = []
    const innerRequest = { ...base, history, type: 'completionStream' } as CompletionStreamRequest

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

  // Turn cap reached without a natural end. Emit a terminal done frame so
  // the client's fold ends deterministically; the last turn's events carry
  // whatever the model produced.
  yield { type: 'completionOrchestrate', done: true }
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
  yield* orchestrateCompletion(request, runTurn, reader)
}
