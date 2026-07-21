import type {
  JsonValue,
  RuntimeErrorEnvelope
} from '@qvac/runtime-contracts'

export interface HarnessMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
}

export interface HarnessAbortSignal {
  readonly aborted: boolean
  readonly reason?: object | string | number | boolean | null
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean }
  ): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export type HarnessEvent =
  | { readonly type: 'content'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | {
      readonly type: 'tool-call'
      readonly name: string
      readonly args: Readonly<Record<string, JsonValue>>
    }
  | {
      readonly type: 'tool-result'
      readonly name: string
      readonly result: JsonValue
    }
  | { readonly type: 'metrics'; readonly metrics: Readonly<Record<string, number>> }
  | {
      readonly type: 'error'
      readonly message: string
      readonly error?: RuntimeErrorEnvelope
    }
  | { readonly type: 'aborted' }

export interface HarnessRunInput {
  readonly runId: string
  readonly traceId?: string
  readonly model: string
  readonly messages: readonly HarnessMessage[]
  readonly signal: HarnessAbortSignal
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncIterable<HarnessEvent>
  close(): Promise<void>
}

export interface HarnessStateAdapter {
  append(runId: string, event: HarnessEvent): Promise<void>
  read(runId: string): Promise<readonly HarnessEvent[]>
  close(): Promise<void>
}
