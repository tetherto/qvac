import type {
  HarnessEvent,
  HarnessMessage,
  HarnessRuntime
} from '@qvac/harness'
import type {
  RuntimeHandshake,
  RuntimeLoggingConfig
} from '@qvac/runtime-contracts'
import type {
  SyncCoreOptions,
  SyncPairingInvite,
  SyncPairingRequest,
  SyncTask,
  SyncTaskStatus,
  SyncUserProfile
} from '@qvac/sync'

export interface AssistantStateEndpoint {
  getIdentity(): Promise<{ deviceId: Buffer }>
  getUserProfile(): Promise<{ profile?: SyncUserProfile | null }>
  setUserProfile(profile: SyncUserProfile): Promise<SyncUserProfile>
  createTask(request: {
    id: string
    title: string
    input: string
  }): Promise<SyncTask>
  updateTask(request: {
    id: string
    title?: string | null
    status?: SyncTaskStatus | null
    result?: string | null
  }): Promise<SyncTask>
  getTask(request: { id: string }): Promise<{ task?: SyncTask | null }>
  listTasks(): Promise<{ tasks: SyncTask[] }>
  watchTasks(): AsyncIterable<{ tasks: SyncTask[] }>
  createPairingInvite(request?: {
    expiresInMs?: number
  }): Promise<SyncPairingInvite>
  approvePairingRequest(request: {
    id: Buffer
  }): Promise<SyncPairingRequest>
  rejectPairingRequest(request: {
    id: Buffer
  }): Promise<SyncPairingRequest>
  watchPairingRequests(): AsyncIterable<{
    requests: SyncPairingRequest[]
  }>
}

export interface AssistantComponent {
  readonly handshake: RuntimeHandshake
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
  readonly state: AssistantStateEndpoint
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
  readonly sync?: Omit<SyncCoreOptions, 'storagePath'>
  readonly inference?: AssistantInference
  readonly logging?: RuntimeLoggingConfig
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
