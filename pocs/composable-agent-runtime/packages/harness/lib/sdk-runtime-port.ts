import type {
  HarnessAbortSignal,
  HarnessJsonValue,
  HarnessMessage
} from './types.ts'

export type SdkRuntimeEvent =
  | { readonly type: 'content-delta' | 'contentDelta'; readonly text: string }
  | { readonly type: 'thinking-delta' | 'thinkingDelta'; readonly text: string }
  | {
      readonly type: 'tool-call' | 'toolCall'
      readonly name: string
      readonly arguments: Readonly<Record<string, HarnessJsonValue>>
    }
  | {
      readonly type: 'tool-result' | 'toolResult'
      readonly name: string
      readonly result: HarnessJsonValue
    }
  | { readonly type: 'metrics'; readonly metrics: Readonly<Record<string, number>> }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'cancelled' | 'aborted' }

export interface SdkCompletionRun {
  readonly requestId: string
  readonly events: AsyncIterable<SdkRuntimeEvent>
}

export interface SdkRuntimePort {
  readonly exited?: Promise<{
    readonly code: number | null
    readonly signal: string | null
  }>
  loadModel(input: {
    readonly model: string
    readonly traceId: string
    readonly signal?: HarnessAbortSignal
  }): Promise<{ readonly modelId: string }>
  completion(input: {
    readonly requestId: string
    readonly traceId: string
    readonly modelId: string
    readonly messages: readonly HarnessMessage[]
    readonly signal: HarnessAbortSignal
  }): SdkCompletionRun
  cancel(input: { readonly requestId: string }): Promise<void>
  heartbeat(): Promise<{ readonly ok: boolean }>
  close(): Promise<void>
}
