import type {
  HarnessAbortSignal,
  HarnessJsonValue,
  HarnessMessage
} from './types.ts'
import type { HarnessToolSchema } from './tool-broker.ts'

export type SdkRuntimeEvent =
  | { readonly type: 'content-delta' | 'contentDelta'; readonly text: string }
  | { readonly type: 'thinking-delta' | 'thinkingDelta'; readonly text: string }
  | {
      readonly type: 'tool-call' | 'toolCall'
      readonly id?: string
      readonly name: string
      readonly arguments: Readonly<Record<string, HarnessJsonValue>>
      readonly raw?: string
    }
  | {
      readonly type: 'tool-result' | 'toolResult'
      readonly name: string
      readonly result: HarnessJsonValue
    }
  | {
      readonly type: 'completion-done' | 'completionDone'
      readonly raw?: { readonly fullText: string }
    }
  | { readonly type: 'metrics'; readonly metrics: Readonly<Record<string, number>> }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'cancelled' | 'aborted' }

export interface SdkCompletionRun {
  readonly requestId: string
  readonly events: AsyncIterable<SdkRuntimeEvent>
}

export interface SdkImageProgress {
  readonly step: number
  readonly totalSteps: number
  readonly elapsedMs: number
}

export interface SdkImageGenerationInput {
  readonly requestId: string
  readonly traceId: string
  readonly prompt: string
  readonly negativePrompt?: string
  readonly width: number
  readonly height: number
  readonly steps?: number
  readonly seed?: number
  readonly signal: HarnessAbortSignal
  readonly onProgress: (progress: SdkImageProgress) => Promise<void>
}

export type SdkImageGenerationResult =
  | {
      readonly status: 'success'
      readonly image: Uint8Array
      readonly stats: Readonly<Record<string, number>>
    }
  | {
      readonly status: 'busy'
      readonly message: string
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
    readonly toolSupport?: boolean
  }): Promise<{ readonly modelId: string }>
  completion(input: {
    readonly requestId: string
    readonly traceId: string
    readonly modelId: string
    readonly messages: readonly HarnessMessage[]
    readonly signal: HarnessAbortSignal
    readonly tools?: readonly HarnessToolSchema[]
  }): SdkCompletionRun
  generateImage(input: SdkImageGenerationInput): Promise<SdkImageGenerationResult>
  cancel(input: { readonly requestId: string }): Promise<void>
  heartbeat(): Promise<{ readonly ok: boolean }>
  close(): Promise<void>
}
