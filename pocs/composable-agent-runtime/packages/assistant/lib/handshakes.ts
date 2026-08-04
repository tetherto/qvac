import type { ComponentHandshake } from './compatibility.ts'

const BUILD_VERSION = '0.0.0-poc'

export interface RuntimeIdentity {
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly buildVersion: string
}

export function syncHandshake(): ComponentHandshake {
  return {
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
    requiredPeerCapabilities: [],
    buildVersion: BUILD_VERSION
  }
}

export function harnessHandshake(): ComponentHandshake {
  return {
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['execution.run', 'state.sync'],
    requiredPeerCapabilities: [],
    buildVersion: BUILD_VERSION
  }
}

export function expectedSyncHandshake(): ComponentHandshake {
  return {
    ...syncHandshake(),
    requiredPeerCapabilities: ['profile-protocol', 'durable-work', 'writer-pairing']
  }
}

export function expectedHarnessHandshake(): ComponentHandshake {
  return {
    ...harnessHandshake(),
    requiredPeerCapabilities: ['execution.run', 'state.sync']
  }
}

export function handshakeFrom(identity: RuntimeIdentity): ComponentHandshake {
  return {
    contract: identity.contract,
    protocolVersion: identity.protocolVersion,
    capabilities: [...identity.capabilities],
    requiredPeerCapabilities: [],
    buildVersion: identity.buildVersion
  }
}

export function assertRuntimeIdentity(
  identity: RuntimeIdentity,
  expected: {
    readonly contract: string
    readonly protocolVersion: number
    readonly requiredCapabilities: readonly string[]
  }
) {
  if (identity.contract !== expected.contract) {
    throw new Error(`contract mismatch: ${expected.contract} != ${identity.contract}`)
  }
  if (identity.protocolVersion !== expected.protocolVersion) {
    throw new Error(
      `protocol mismatch: ${expected.protocolVersion} != ${identity.protocolVersion}`
    )
  }
  const missing = expected.requiredCapabilities.filter(
    (capability) => !identity.capabilities.includes(capability)
  )
  if (missing.length > 0) {
    throw new Error(`required capabilities missing (${missing.join(', ')})`)
  }
}
