export interface ComponentHandshake {
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly requiredPeerCapabilities: readonly string[]
  readonly buildVersion: string
}

export interface CompatibilityResult {
  readonly compatible: boolean
  readonly negotiatedCapabilities: readonly string[]
  readonly missingLocalCapabilities: readonly string[]
  readonly missingRemoteCapabilities: readonly string[]
  readonly reason?: string
}

export function checkCompatibility(
  local: ComponentHandshake,
  remote: ComponentHandshake
): CompatibilityResult {
  const negotiatedCapabilities = local.capabilities.filter((capability) =>
    remote.capabilities.includes(capability)
  )
  const missingLocalCapabilities = remote.requiredPeerCapabilities.filter(
    (capability) => !local.capabilities.includes(capability)
  )
  const missingRemoteCapabilities = local.requiredPeerCapabilities.filter(
    (capability) => !remote.capabilities.includes(capability)
  )
  const base = {
    negotiatedCapabilities,
    missingLocalCapabilities,
    missingRemoteCapabilities
  }

  if (local.contract !== remote.contract) {
    return {
      compatible: false,
      ...base,
      reason: `contract mismatch: ${local.contract} != ${remote.contract}`
    }
  }

  if (local.protocolVersion !== remote.protocolVersion) {
    return {
      compatible: false,
      ...base,
      reason: `protocol mismatch: ${local.protocolVersion} != ${remote.protocolVersion}`
    }
  }

  if (
    missingLocalCapabilities.length > 0 ||
    missingRemoteCapabilities.length > 0
  ) {
    return {
      compatible: false,
      ...base,
      reason: 'required capabilities missing'
    }
  }

  return {
    compatible: true,
    ...base
  }
}
