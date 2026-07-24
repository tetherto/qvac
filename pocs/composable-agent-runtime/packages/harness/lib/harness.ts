import QvacLogger from '@qvac/logging'
import {
  HarnessExecutionError,
  serializeHarnessError
} from './errors.ts'
import { createMemoryStateAdapter } from './memory-state.ts'
import type { SdkRuntimeEvent, SdkRuntimePort } from './sdk-runtime-port.ts'
import type {
  HarnessEvent,
  HarnessLoggingConfig,
  HarnessRunInput,
  HarnessRuntime,
  HarnessStateAdapter
} from './types.ts'

export interface CreateHarnessOptions {
  readonly sdk: SdkRuntimePort
  readonly state?: HarnessStateAdapter
  readonly logging?: HarnessLoggingConfig
}

export function createHarness({
  sdk,
  state = createMemoryStateAdapter(),
  logging
}: CreateHarnessOptions): HarnessRuntime {
  let closed = false
  const write = (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: write,
    warn: write,
    info: write,
    debug: write
  })
  logger.setLevel(logging?.level ?? 'off')
  const logPrefix = '[harness]'

  async function* run(input: HarnessRunInput): AsyncGenerator<HarnessEvent> {
    if (closed) throw new Error('harness is closed')
    const traceId = input.traceId ?? input.runId
    logger.info(logPrefix, 'run started', { runId: input.runId, traceId })
    if (input.signal.aborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
      return
    }

    const loaded = await sdk.loadModel({
      model: input.model,
      traceId,
      signal: input.signal
    })
    if (input.signal.aborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
      return
    }

    const completion = sdk.completion({
      requestId: input.runId,
      traceId,
      modelId: loaded.modelId,
      messages: input.messages,
      signal: input.signal
    })
    let cancelled = false
    let emittedAborted = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      void sdk.cancel({ requestId: completion.requestId }).catch(() => {})
    }
    input.signal.addEventListener('abort', cancel, { once: true })

    try {
      for await (const sdkEvent of completion.events) {
        if (input.signal.aborted) {
          if (!emittedAborted) {
            emittedAborted = true
            yield await persist(state, input.runId, { type: 'aborted' })
          }
          return
        }
        const mapped = mapSdkEvent(sdkEvent)
        const event =
          mapped.type === 'error' && mapped.error === undefined
            ? {
                ...mapped,
                error: serializeHarnessError(
                  new HarnessExecutionError(
                    'harness->sdk',
                    new Error(mapped.message)
                  ),
                  { traceId, boundary: 'harness->sdk' }
                )
              }
            : mapped
        if (event.type === 'aborted') emittedAborted = true
        yield await persist(state, input.runId, event)
      }
    } catch (cause) {
      if (input.signal.aborted) {
        if (!emittedAborted) yield await persist(state, input.runId, { type: 'aborted' })
        return
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      const error = new HarnessExecutionError('harness->sdk', cause)
      logger.error(logPrefix, 'run failed', {
        runId: input.runId,
        traceId,
        error: message
      })
      yield await persist(state, input.runId, {
        type: 'error',
        message,
        error: serializeHarnessError(error, {
          traceId,
          boundary: 'harness->sdk'
        })
      })
    } finally {
      input.signal.removeEventListener('abort', cancel)
    }

    if (input.signal.aborted && !emittedAborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
    }
    logger.info(logPrefix, 'run completed', { runId: input.runId, traceId })
  }

  return {
    run,
    async close() {
      if (closed) return
      closed = true
      await Promise.all([sdk.close(), state.close()])
    }
  }
}

async function persist(state: HarnessStateAdapter, runId: string, event: HarnessEvent) {
  await state.append(runId, event)
  return event
}

export function mapSdkEvent(event: SdkRuntimeEvent): HarnessEvent {
  switch (event.type) {
    case 'content-delta':
    case 'contentDelta':
      return { type: 'content', text: event.text }
    case 'thinking-delta':
    case 'thinkingDelta':
      return { type: 'thinking', text: event.text }
    case 'tool-call':
    case 'toolCall':
      return { type: 'tool-call', name: event.name, args: event.arguments }
    case 'tool-result':
    case 'toolResult':
      return { type: 'tool-result', name: event.name, result: event.result }
    case 'metrics':
      return { type: 'metrics', metrics: event.metrics }
    case 'error':
      return { type: 'error', message: event.message }
    case 'cancelled':
    case 'aborted':
      return { type: 'aborted' }
    default:
      return { type: 'error', message: `unmapped SDK event: ${Reflect.get(event, 'type')}` }
  }
}
