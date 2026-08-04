import type {
  HarnessAgentRegistration,
  HarnessAgentRunKey,
  HarnessEvent,
  HarnessRunRecord,
  HarnessRuntime
} from '@qvac/harness'
import type { LogLevel } from '@qvac/logging'
import type {
  CreateSyncOptions,
  SyncProfileClient,
  SyncRuntime
} from '@qvac/sync'
import type {
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
} from '@qvac/sync/profiles/durable-work'
import type { ComponentHandshake } from './compatibility.ts'

export type AssistantComponentHandshake = ComponentHandshake

export type AssistantWorkEndpoint = SyncProfileClient<
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
>

export type AssistantStateEndpoint = Pick<
  SyncRuntime,
  'ready' | 'suspend' | 'resume' | 'lifecycle' | 'runtime' | 'mesh'
> & { readonly work: AssistantWorkEndpoint }

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
}

export interface AssistantComponents {
  startSync(): Promise<AssistantSyncComponent>
  startHarness(input: {
    readonly state: SyncRuntime
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
}

export interface AssistantRunInput {
  readonly agentId: string
  readonly runId?: string
  readonly input: string
  readonly signal?: AbortSignal
}

export interface AssistantRun extends AsyncIterable<HarnessEvent> {
  readonly id: string
}

export type AssistantAgentRegistration = HarnessAgentRegistration
export type AssistantRunKey = HarnessAgentRunKey
export type AssistantRunRecord = HarnessRunRecord

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
  readonly children: ReadonlyArray<{
    readonly name: string
    readonly state: string
    readonly deps: readonly string[]
    readonly lives: number
    readonly details?: Readonly<Record<string, unknown>>
  }>
}
