import type { JsonValue } from '@qvac/runtime-contracts'
import type { SdkRuntimeEvent, SdkRuntimePort } from './sdk-runtime-port.ts'

interface SdkCompletionEvent {
  readonly type:
    | 'contentDelta'
    | 'thinkingDelta'
    | 'rawDelta'
    | 'toolCall'
    | 'toolError'
    | 'completionStats'
    | 'completionDone'
  readonly text?: string
  readonly call?: {
    readonly name: string
    readonly arguments: Readonly<Record<string, JsonValue>>
  }
  readonly error?: { readonly message: string }
  readonly stats?: Readonly<Record<string, number | string | undefined>>
  readonly stopReason?: 'eos' | 'length' | 'stopSequence' | 'cancelled' | 'error'
}

interface SdkModule {
  loadModel(input: { readonly modelSrc: string; readonly modelType: string }): Promise<string>
  completion(input: {
    readonly modelId: string
    readonly history: readonly { readonly role: string; readonly content: string }[]
    readonly stream: true
    readonly generationParams?: {
      readonly predict?: number
      readonly reasoning_budget?: number
    }
  }): { readonly requestId: string; readonly events: AsyncIterable<SdkCompletionEvent> }
  cancel(input: { readonly requestId: string }): Promise<void>
  heartbeat(): Promise<object>
  close(): Promise<void>
}

export async function createSdkDirectAdapter(): Promise<SdkRuntimePort> {
  const [{ close, plugins }, { llmPlugin }] = await Promise.all([
    import('@qvac/sdk'),
    import('@qvac/sdk/llamacpp-completion/plugin')
  ])
  const sdk = { ...plugins([llmPlugin]), close } as SdkModule

  return {
    async loadModel({ model }) {
      const modelId = await sdk.loadModel({
        modelSrc: model,
        modelType: 'llamacpp-completion'
      })
      return { modelId }
    },
    completion({ modelId, messages }) {
      const run = sdk.completion({
        modelId,
        history: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        generationParams: {
          predict: 128,
          reasoning_budget: 0
        }
      })
      return {
        requestId: run.requestId,
        events: sdkEvents(run.events)
      }
    },
    async cancel({ requestId }) {
      await sdk.cancel({ requestId })
    },
    async heartbeat() {
      await sdk.heartbeat()
      return { ok: true }
    },
    async close() {
      await sdk.close()
    }
  }
}

async function* sdkEvents(
  events: AsyncIterable<SdkCompletionEvent>
): AsyncGenerator<SdkRuntimeEvent> {
  for await (const event of events) {
    switch (event.type) {
      case 'contentDelta':
      case 'thinkingDelta':
        yield { type: event.type, text: event.text ?? '' }
        break
      case 'toolCall':
        if (!event.call) {
          yield { type: 'error', message: 'SDK tool call omitted call details' }
          break
        }
        yield {
          type: 'toolCall',
          name: event.call.name,
          arguments: event.call.arguments
        }
        break
      case 'completionStats': {
        const metrics: Record<string, number> = {}
        for (const [key, value] of Object.entries(event.stats ?? {})) {
          if (typeof value === 'number') metrics[key] = value
        }
        yield { type: 'metrics', metrics }
        break
      }
      case 'toolError':
        yield { type: 'error', message: event.error?.message ?? 'SDK tool error' }
        break
      case 'completionDone':
        if (event.stopReason === 'cancelled') yield { type: 'cancelled' }
        else if (event.stopReason === 'error') {
          yield { type: 'error', message: event.error?.message ?? 'SDK completion error' }
        }
        break
      case 'rawDelta':
        break
    }
  }
}
