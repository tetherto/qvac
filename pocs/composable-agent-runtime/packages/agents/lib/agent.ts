import type { AgentAbortSignal, AgentCheckpoint, AgentDefinition, AgentEvent, AgentMessage, AgentOperation, AgentOutput, AgentRun, AgentRunOptions, AgentRunResult, CanceledRunResult, CompletedRunResult, DefinedAgent, ModelRequest, WorkflowContext } from './types.ts'

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
  outputs: readonly AgentOutput[]
): AgentCheckpoint {
  return {
    version: 1,
    agentId: definition.id,
    runId,
    nextOperationIndex,
    outputs: outputs.map((output) => ({ ...output }))
  }
}

function validateCheckpoint(
  definition: AgentDefinition,
  runId: string,
  operations: readonly AgentOperation[],
  checkpoint: AgentCheckpoint
) {
  if (checkpoint.version !== 1) throw new Error('unsupported checkpoint version')
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
}

function promptFor(operation: AgentOperation, context: WorkflowContext) {
  return typeof operation.prompt === 'string' ? operation.prompt : operation.prompt(context)
}

function messagesFor(definition: AgentDefinition, prompt: string): AgentMessage[] {
  const messages: AgentMessage[] = []
  if (definition.instructions) messages.push({ role: 'system', content: definition.instructions })
  messages.push({ role: 'user', content: prompt })
  return messages
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

  async function cancel(reason = 'canceled') {
    if (source.signal.aborted) return canceling
    source.abort(reason)
    if (!activeOperationId || !options.adapter.cancel) return canceling
    canceling = Promise.resolve(options.adapter.cancel(activeOperationId))
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
        yield {
          type: 'operation-started',
          runId: options.runId,
          operationId: activeOperationId
        }

        const context: WorkflowContext = { input: options.input, outputs: [...outputs] }
        const request: ModelRequest = {
          model: definition.model,
          messages: messagesFor(definition, promptFor(operation, context)),
          runId: options.runId,
          operationId: activeOperationId,
          signal: source.signal
        }
        let output = ''
        for await (const event of options.adapter.stream(request)) {
          if (source.signal.aborted) break
          output += event.text
          yield {
            type: 'content',
            runId: options.runId,
            operationId: activeOperationId,
            text: event.text
          }
        }
        if (source.signal.aborted) break

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
        const checkpoint = checkpointFor(definition, options.runId, nextOperationIndex, outputs)
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
