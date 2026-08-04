import type {
  HarnessEvent,
  HarnessMessage,
  HarnessRuntime
} from '@qvac/harness/types'
import type { LogLevel } from '@qvac/logging'
import type {
  CreateSyncOptions,
  SyncRuntime
} from '@qvac/sync'
import type { ComponentHandshake } from './compatibility.ts'

export type AssistantComponentHandshake = ComponentHandshake

export type AssistantStateEndpoint = Pick<
  SyncRuntime,
  'ready' | 'suspend' | 'resume' | 'lifecycle' | 'runtime' | 'mesh' | 'openProfile'
>

export interface AssistantComponent {
  readonly handshake: AssistantComponentHandshake
  readonly exited?: Promise<{
    readonly code: number | null
    readonly signal: string | null
  }>
  close(): Promise<void>
  suspend?(): Promise<void>
  resume?(): Promise<void>
  inspect?(): Readonly<Record<string, object | string | number | boolean | null>>
}

export interface AssistantSyncComponent extends AssistantComponent {
  readonly state: SyncRuntime
}

export interface AssistantHarnessComponent extends AssistantComponent {
  readonly harness: HarnessRuntime
  readRun(runId: string): Promise<readonly HarnessEvent[]>
}

export interface AssistantComponents {
  startSync(): Promise<AssistantSyncComponent>
  startHarness(input: {
    readonly state: AssistantStateEndpoint
  }): Promise<AssistantHarnessComponent>
}

export type AssistantInference =
  | { readonly kind: 'deterministic' }
  | { readonly kind: 'qwen' }

export interface CreateAssistantOptions {
  readonly storagePath?: string
  readonly sync?: Omit<CreateSyncOptions, 'storagePath'>
  readonly inference?: AssistantInference
  readonly logging?: { readonly level?: LogLevel }
  readonly components?: AssistantComponents
}

export interface AssistantRunInput {
  readonly runId?: string
  readonly traceId?: string
  readonly model?: string
  readonly messages: readonly HarnessMessage[]
  readonly signal?: AbortSignal
}

export interface AssistantRun extends AsyncIterable<HarnessEvent> {
  readonly id: string
  readonly traceId: string
}

export type AssistantLifecycleEventType =
  | 'child-ready'
  | 'child-died'
  | 'child-restarting'
  | 'child-stopped'
  | 'child-reloaded'
  | 'gave-up'
  | 'suspend-coalesced'
  | 'stall'

export interface AssistantLifecycleEvent {
  readonly type: AssistantLifecycleEventType
  readonly timestamp: number
  readonly name?: string
  readonly lives?: number
  readonly delay?: number
  readonly error?: {
    readonly name: string
    readonly message: string
  }
}

export interface AssistantInspection {
  readonly sdkStarts: number
  readonly children: ReadonlyArray<{
    readonly name: string
    readonly state: string
    readonly deps: readonly string[]
    readonly lives: number
    readonly details?: Readonly<Record<string, unknown>>
  }>
}
