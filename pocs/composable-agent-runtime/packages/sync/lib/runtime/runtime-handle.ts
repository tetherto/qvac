export type SyncRuntimePhase =
  | 'opening'
  | 'ready'
  | 'suspended'
  | 'failed'
  | 'closed'

export type SyncNetworkState =
  | 'stopped'
  | 'starting'
  | 'online'
  | 'offline'
  | 'degraded'

export interface SyncRuntimeStatus {
  readonly phase: SyncRuntimePhase
  readonly generation: string
  readonly network: SyncNetworkState
  readonly writable: boolean
  readonly peerCount: number
}

export interface SyncRuntimeDiagnostics {
  readonly children: ReadonlyArray<{
    readonly name: string
    readonly state: string
    readonly deps: readonly string[]
    readonly info?: {
      readonly discoveryTeardownComplete?: boolean
      readonly topicPresent?: boolean
    }
  }>
}
