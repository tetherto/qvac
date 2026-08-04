export interface SyncCompatibilityReport {
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly requiredPeerCapabilities: readonly string[]
  readonly buildVersion: string
}

export interface SyncRuntimeHandshake {
  readonly contract: 'qvac.sync'
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly requiredPeerCapabilities: readonly string[]
  readonly buildVersion: string
}

export const syncCompatibility = {
  contract: 'qvac.sync',
  protocolVersion: 1,
  capabilities: [
    'profile-protocol',
    'durable-work',
    'passive-replication',
    'writer-pairing',
    'dynamic-membership',
    'runtime-lifecycle',
    'device-management'
  ],
  requiredPeerCapabilities: ['profile-protocol'],
  buildVersion: '0.0.0-poc'
} as const satisfies SyncCompatibilityReport

export function assertCompatibleRuntime(
  local: SyncCompatibilityReport,
  remote: SyncCompatibilityReport
) {
  if (remote.contract !== local.contract) {
    throw new Error(
      `Incompatible Sync contract: expected ${local.contract}, got ${remote.contract}`
    )
  }
  if (remote.protocolVersion !== local.protocolVersion) {
    throw new Error(
      `Incompatible Sync protocol version: expected ${local.protocolVersion}, got ${remote.protocolVersion}`
    )
  }
  for (const capability of local.requiredPeerCapabilities) {
    if (!remote.capabilities.includes(capability)) {
      throw new Error(`Incompatible Sync peer capability missing: ${capability}`)
    }
  }
}
