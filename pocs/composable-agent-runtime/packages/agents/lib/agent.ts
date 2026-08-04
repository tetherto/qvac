import { createToolGate, type AgentToolCall, type AgentToolGate } from './tools.ts'
import { CHECKPOINT_VERSION, type AgentAbortSignal, type AgentCheckpoint, type AgentDefinition, type AgentEvent, type AgentMessage, type AgentOperation, type AgentOperationCheckpoint, type AgentOutput, type AgentRun, type AgentRunOptions, type AgentRunResult, type CanceledRunResult, type CompletedRunResult, type DefinedAgent, type ModelRequest, type WorkflowContext } from './types.ts'

export const DEFAULT_TURN_BUDGET = 10
export const TURN_BUDGET_FALLBACK = 'Tool round limit reached before a final response.'

const NO_TOOL_POLICY = { allow: [], requireApproval: [] } as const

interface CancelSource {
  readonly signal: AgentAbortSignal
  abort(reason: string): void
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

const DEFAULT_OPERATION: AgentOperation = { id: 'respond', prompt: (context) => context.input }

function createCancelSource(): CancelSource {
  const listeners = new Set<() => void>()
  let aborted = false
  let reason: string | undefined
  const signal: AgentAbortSignal = {
    get aborted() {
      return aborted
    },
    get reason() {
      return reason
    },
    addEventListener(_type, listener) {
      if (aborted) {
        listener()
        return
      }
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    }
  }
  return {
    signal,
    abort(nextReason) {
      if (aborted) return
      aborted = true
      reason = nextReason
      for (const listener of listeners) listener()
      listeners.clear()
    }
  }
}

function createEventQueue() {
  let buffered: AgentEvent[] = []
  return {
    push(event: AgentEvent) {
      buffered.push(event)
    },
    *drain(): Generator<AgentEvent> {
      if (buffered.length === 0) return
      const pending = buffered
      buffered = []
      yield* pending
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
    reject(error) {
      rejectPromise?.(error)
    }
  }
}

function operationId(runId: string, operation: AgentOperation) {
  return `${runId}/${operation.id}`
}

function checkpointFor(
  definition: AgentDefinition,
  runId: string,
  nextOperationIndex: number,
  outputs: readonly AgentOutput[],
  operation?: AgentOperationCheckpoint
): AgentCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    agentId: definition.id,
    runId,
    nextOperationIndex,
    outputs: outputs.map((output) => ({ ...output })),
    ...(operation
      ? {
          operation: {
            operationId: operation.operationId,
            round: operation.round,
            messages: operation.messages.map((message) => ({ ...message }))
          }
        }
      : {})
  }
}

function validateCheckpoint(
  definition: AgentDefinition,
  runId: string,
  operations: readonly AgentOperation[],
  checkpoint: AgentCheckpoint
) {
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(
      `unsupported checkpoint version: expected ${CHECKPOINT_VERSION}, received ${String(checkpoint.version)}`
    )
  }
  if (checkpoint.agentId !== definition.id) throw new Error('checkpoint agent does not match')
  if (checkpoint.runId !== runId) throw new Error('checkpoint run does not match')
  if (checkpoint.nextOperationIndex !== checkpoint.outputs.length) {
    throw new Error('checkpoint operation index does not match its outputs')
  }
  if (checkpoint.nextOperationIndex < 0 || checkpoint.nextOperationIndex > operations.length) {
    throw new Error('checkpoint operation index is out of range')
  }
  for (let index = 0; index < checkpoint.outputs.length; index++) {
    const operation = operations[index]
    const output = checkpoint.outputs[index]
    if (!operation || output?.operationId !== operationId(runId, operation)) {
      throw new Error('checkpoint operation ids do not match the workflow')
    }
  }
  const resumed = checkpoint.operation
  if (!resumed) return
  const operation = operations[checkpoint.nextOperationIndex]
  if (!operation || resumed.operationId !== operationId(runId, operation)) {
    throw new Error('checkpoint operation state does not match the workflow')
  }
  if (!Number.isSafeInteger(resumed.round) || resumed.round < 0) {
    throw new Error('checkpoint operation round is invalid')
  }
}

function promptFor(operation: AgentOperation, context: WorkflowContext) {
  return typeof operation.prompt === 'string' ? operation.prompt : operation.prompt(context)
}

function messagesFor(definition: AgentDefinition, prompt: string): AgentMessage[] {
  const messages: AgentMessage[] = []
  if (definition.instructions) messages.push({ role: 'system', content: definition.instructions })
  for (const block of definition.systemPrompt ?? []) {
    if (block.text) messages.push({ role: 'system', content: block.text })
  }
  messages.push({ role: 'user', content: prompt })
  return messages
}

/**
 * Assistant turn recorded in history. A provider's canonical text wins, since
 * replaying reconstructed text can drop provider-native tool-call framing.
 */
function assistantHistory(
  canonicalRaw: string | undefined,
  content: readonly string[],
  calls: readonly (AgentToolCall & { readonly raw?: string })[]
) {
  if (canonicalRaw !== undefined) return canonicalRaw
  const text = content.join('')
  if (text) return text
  return JSON.stringify({
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(call.raw ? { raw: call.raw } : {})
    }))
  })
}

function errorFrom(value: Error | string) {
  return value instanceof Error ? value : new Error(value)
}

function createRun(
  definition: AgentDefinition,
  operations: readonly AgentOperation[],
  options: AgentRunOptions
): AgentRun {
  const source = createCancelSource()
  const deferred = createDeferred<AgentRunResult>()
  let activeOperationId: string | undefined
  let canceling: Promise<void> = Promise.resolve()
  const turnBudget = definition.turnBudget ?? DEFAULT_TURN_BUDGET
  // Progress arrives through a callback while a tool runs, but a generator
  // cannot yield from a callback. Buffer and drain at the next safe point.
  const progressQueue = createEventQueue()
  let resumedOperation = options.checkpoint?.operation
  let pendingOperation: AgentOperationCheckpoint | undefined
  const gate: AgentToolGate = createToolGate({
    ...options.tooling,
    policy: definition.toolPolicy ?? NO_TOOL_POLICY,
    events: {
      onApprovalRequested(invocation) {
        return progressQueue.push({
          type: 'approval-requested',
          runId: options.runId,
          operationId: invocation.operationId,
          callId: invocation.call.id,
          name: invocation.call.name
        })
      },
      onApprovalResolved(invocation, approved) {
        return progressQueue.push({
          type: 'approval-resolved',
          runId: options.runId,
          operationId: invocation.operationId,
          callId: invocation.call.id,
          name: invocation.call.name,
          approved
        })
      }
    }
  })

  async function cancel(reason = 'canceled') {
    if (source.signal.aborted) return canceling
    source.abort(reason)
    if (!activeOperationId) return canceling
    const operationId = activeOperationId
    // Both the model and any in-flight tool have to be told; cancelling only
    // the model leaves a side-effecting tool running past the run.
    canceling = Promise.all([
      Promise.resolve(options.adapter.cancel?.(operationId)),
      gate.cancel({ agentId: definition.id, runId: options.runId, operationId })
    ]).then(() => undefined)
    return canceling
  }

  const onExternalAbort = () => {
    void cancel(options.signal?.reason ?? 'aborted')
  }
  if (options.signal?.aborted) source.abort(options.signal.reason ?? 'aborted')
  else options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  async function* execute(): AsyncGenerator<AgentEvent> {
    try {
      if (options.checkpoint) {
        validateCheckpoint(definition, options.runId, operations, options.checkpoint)
      }
      const outputs = options.checkpoint?.outputs.map((output) => ({ ...output })) ?? []
      let nextOperationIndex = options.checkpoint?.nextOperationIndex ?? 0

      if (!source.signal.aborted) yield { type: 'run-started', runId: options.runId }

      while (nextOperationIndex < operations.length && !source.signal.aborted) {
        const operation = operations[nextOperationIndex]
        if (!operation) throw new Error('workflow operation is missing')
        activeOperationId = operationId(options.runId, operation)
        // Stable local binding: closures below outlive the narrowing of the
        // mutable `activeOperationId`.
        const currentOperationId = activeOperationId
        yield {
          type: 'operation-started',
          runId: options.runId,
          operationId: activeOperationId
        }

        const context: WorkflowContext = { input: options.input, outputs: [...outputs] }
        // Resume mid-operation only when the checkpoint describes this exact
        // operation; otherwise start the conversation fresh.
        const resumed =
          resumedOperation?.operationId === activeOperationId ? resumedOperation : undefined
        resumedOperation = undefined
        const messages: AgentMessage[] =
          resumed?.messages.map((message) => ({ ...message })) ??
          messagesFor(definition, promptFor(operation, context))
        let output = ''
        let round = resumed?.round ?? 0
        let exhausted = true

        for (; round < turnBudget; round++) {
          if (source.signal.aborted) break
          const request: ModelRequest = {
            model: definition.model,
            messages: messages.map((message) => ({ ...message })),
            runId: options.runId,
            operationId: activeOperationId,
            signal: source.signal,
            round,
            ...(gate.schemas.length > 0 ? { tools: gate.schemas } : {})
          }
          const content: string[] = []
          const calls: Array<AgentToolCall & { readonly raw?: string }> = []
          let canonicalRaw: string | undefined

          for await (const event of options.adapter.stream(request)) {
            if (source.signal.aborted) break
            if (event.type === 'content') {
              // Streamed as it arrives; whether it counts as the operation's
              // answer is decided once the round ends.
              content.push(event.text)
              yield {
                type: 'content',
                runId: options.runId,
                operationId: currentOperationId,
                text: event.text
              }
              continue
            }
            if (event.type === 'tool-call') {
              calls.push({ ...event.call, ...(event.raw ? { raw: event.raw } : {}) })
              yield {
                type: 'tool-call',
                runId: options.runId,
                operationId: currentOperationId,
                call: event.call
              }
              continue
            }
            canonicalRaw = event.raw
          }
          if (source.signal.aborted) break

          if (calls.length === 0) {
            // The model answered instead of calling a tool. Only this round's
            // text is the operation's answer; earlier rounds were narration
            // around tool use and stay out of the output.
            exhausted = false
            output = content.join('')
            break
          }

          messages.push({
            role: 'assistant',
            content: assistantHistory(canonicalRaw, content, calls)
          })
          let aborted = false
          for (const call of calls) {
            const result = await gate.execute({
              agentId: definition.id,
              runId: options.runId,
              operationId: activeOperationId,
              call,
              signal: source.signal,
              reportProgress: async (progress) => {
                if (source.signal.aborted) return
                progressQueue.push({
                  type: 'tool-progress',
                  runId: options.runId,
                  operationId: currentOperationId,
                  callId: call.id,
                  name: call.name,
                  progress
                })
              }
            })
            if (source.signal.aborted) {
              aborted = true
              break
            }
            yield* progressQueue.drain()
            yield {
              type: 'tool-result',
              runId: options.runId,
              operationId: activeOperationId,
              callId: call.id,
              name: call.name,
              result
            }
            messages.push({ role: 'tool', content: JSON.stringify(result) })
          }
          if (aborted || source.signal.aborted) break
          yield* progressQueue.drain()
        }
        if (source.signal.aborted) {
          // Preserve where the operation got to so a resume does not replay
          // tool calls that already ran.
          pendingOperation = {
            operationId: activeOperationId,
            round,
            messages: messages.map((message) => ({ ...message }))
          }
          break
        }

        if (exhausted) {
          // Distinguishable from a real answer: a caller must be able to tell
          // "the model replied" from "we cut it off".
          yield {
            type: 'budget-exhausted',
            runId: options.runId,
            operationId: currentOperationId,
            rounds: turnBudget
          }
          output = TURN_BUDGET_FALLBACK
          yield {
            type: 'content',
            runId: options.runId,
            operationId: currentOperationId,
            text: TURN_BUDGET_FALLBACK
          }
        }

        outputs.push({ operationId: activeOperationId, output })
        nextOperationIndex++
        const checkpoint = checkpointFor(
          definition,
          options.runId,
          nextOperationIndex,
          outputs
        )
        yield {
          type: 'operation-completed',
          runId: options.runId,
          operationId: activeOperationId,
          output
        }
        yield {
          type: 'checkpoint',
          runId: options.runId,
          operationId: activeOperationId,
          checkpoint
        }
      }

      if (source.signal.aborted) {
        await canceling
        yield* progressQueue.drain()
        const checkpoint = checkpointFor(
          definition,
          options.runId,
          nextOperationIndex,
          outputs,
          pendingOperation
        )
        const reason = source.signal.reason ?? 'canceled'
        const result: CanceledRunResult = {
          status: 'canceled',
          runId: options.runId,
          reason,
          checkpoint
        }
        deferred.resolve(result)
        yield { type: 'run-canceled', runId: options.runId, reason, checkpoint }
        return
      }

      const checkpoint = checkpointFor(definition, options.runId, operations.length, outputs)
      const output = outputs.at(-1)?.output ?? ''
      const result: CompletedRunResult = {
        status: 'completed',
        runId: options.runId,
        output,
        checkpoint
      }
      deferred.resolve(result)
      yield { type: 'run-completed', runId: options.runId, output, checkpoint }
    } catch (value) {
      const error = errorFrom(value instanceof Error ? value : String(value))
      deferred.reject(error)
      throw error
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  void deferred.promise.catch(() => {})
  return { events: execute(), result: deferred.promise, cancel }
}

export function defineAgent(definition: AgentDefinition): DefinedAgent {
  if (!definition.id) throw new Error('agent id is required')
  if (!definition.model) throw new Error('agent model is required')
  if (
    definition.turnBudget !== undefined &&
    (!Number.isSafeInteger(definition.turnBudget) || definition.turnBudget < 1)
  ) {
    throw new Error('agent turn budget must be a positive integer')
  }
  const operations = definition.workflow?.length ? [...definition.workflow] : [DEFAULT_OPERATION]
  const ids = new Set<string>()
  for (const operation of operations) {
    if (!operation.id) throw new Error('workflow operation id is required')
    if (ids.has(operation.id)) throw new Error(`duplicate workflow operation id: ${operation.id}`)
    ids.add(operation.id)
  }
  const frozenDefinition = {
    ...definition,
    workflow: operations.map((operation) => ({ ...operation }))
  }
  return {
    id: frozenDefinition.id,
    model: frozenDefinition.model,
    run(options) {
      return createRun(frozenDefinition, frozenDefinition.workflow, options)
    }
  }
}
