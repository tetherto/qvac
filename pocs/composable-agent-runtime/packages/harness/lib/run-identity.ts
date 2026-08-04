export interface HarnessRunIdentity {
  readonly agentId: string
  readonly runId: string
}

export function encodeRunIdentity(identity: HarnessRunIdentity) {
  return encodeIdentityParts([identity.agentId, identity.runId])
}

export function encodeRunScopedIdentity(
  identity: HarnessRunIdentity,
  scope: readonly (string | number)[]
) {
  return encodeIdentityParts([identity.agentId, identity.runId, ...scope])
}

function encodeIdentityParts(parts: readonly (string | number)[]) {
  return JSON.stringify(parts)
}
