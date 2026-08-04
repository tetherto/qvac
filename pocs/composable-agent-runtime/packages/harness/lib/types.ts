import type { LogLevel } from '@qvac/logging'
import type { HarnessAgentRegistration } from './agent-registration.ts'

export type HarnessJsonValue =
  | boolean
  | number
  | string
  | null
  | HarnessJsonValue[]
  | { [key: string]: HarnessJsonValue }

export interface HarnessErrorEnvelope {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly recoverable: boolean
  readonly traceId?: string
  readonly boundary?: string
  readonly cause?: HarnessErrorEnvelope
}

export interface HarnessLoggingConfig {
  readonly level?: LogLevel
}

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
      readonly args: Readonly<Record<string, HarnessJsonValue>>
    }
  | {
      readonly type: 'tool-result'
      readonly name: string
      readonly result: HarnessJsonValue
    }
  | {
      readonly type: 'tool-progress'
      readonly name: string
      readonly progress: {
        readonly step: number
        readonly totalSteps: number
        readonly elapsedMs: number
      }
    }
  | { readonly type: 'metrics'; readonly metrics: Readonly<Record<string, number>> }
  | {
      readonly type: 'error'
      readonly message: string
      readonly error?: HarnessErrorEnvelope
    }
  | { readonly type: 'aborted' }

export interface HarnessRunInput {
  readonly runId: string
  readonly traceId?: string
  readonly model: string
  readonly messages: readonly HarnessMessage[]
  readonly signal: HarnessAbortSignal
}

export interface HarnessAgentRunInput {
  readonly agentId: string
  readonly runId: string
  readonly input: string
  readonly signal?: HarnessAbortSignal
}

export interface HarnessAgentRunKey {
  readonly agentId: string
  readonly runId: string
  readonly reason?: string
}

export interface HarnessRuntime {
  run(input: HarnessRunInput): AsyncIterable<HarnessEvent>
  close(): Promise<void>
}

export interface LocalHarnessRuntime extends HarnessRuntime {
  registerAgent(registration: HarnessAgentRegistration): Promise<void>
  runAgent(input: HarnessAgentRunInput): AsyncIterable<HarnessEvent>
  cancelAgentRun(input: HarnessAgentRunKey): Promise<void>
}

export interface HarnessStateAdapter {
  append(runId: string, event: HarnessEvent): Promise<void>
  read(runId: string): Promise<readonly HarnessEvent[]>
  close(): Promise<void>
}
