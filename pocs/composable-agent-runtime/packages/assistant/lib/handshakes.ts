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
      'local-profile',
      'tasks',
      'task-watches',
      'passive-replication',
      'writer-pairing'
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
    requiredPeerCapabilities: [
      'local-profile',
      'tasks',
      'task-watches',
      'writer-pairing'
    ]
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
