import { z } from 'zod'
import { CAPABILITY_ID_PATTERN, type CapabilityContract } from '@/schemas/capabilities'

/**
 * The namespace of permissions for operations the runtime serves itself rather
 * than through a plugin. QVAC never defines a capability contract with this ID,
 * and a third-party ID always contains a dot, so no contract can claim it.
 */
export const RUNTIME_PERMISSION_NAMESPACE = 'runtime'

/**
 * Runtime operations a session with a grant may call only with the matching
 * `runtime/<operation>` permission. They load models, fetch files, write
 * storage, stream runtime-wide logs or probe the network.
 */
export const RUNTIME_PERMISSION_OPERATIONS = [
  'loadModel',
  'downloadAsset',
  'vectorIndex',
  'loggingStream',
  'discoverRpcServers'
] as const

export type RuntimePermissionOperation = (typeof RUNTIME_PERMISSION_OPERATIONS)[number]

/**
 * A permission names one operation: `<capability ID>/<operation>`, such as
 * `transcription/transcribe`, or `runtime/<operation>` for a runtime
 * operation. The capability ID is part of the name because two third-party
 * contracts may name an operation alike. A permission carries no major, so
 * its name does not change when the contract's version does.
 */
export const SESSION_PERMISSION_PATTERN = new RegExp(
  `^(${CAPABILITY_ID_PATTERN.source.slice(1, -1)})/([^/\\s]+)$`
)

/** The permission for `operation` of the contract `contractId`. */
export function permissionFor(contractId: string, operation: string): string {
  return `${contractId}/${operation}`
}

/** Splits a permission into its namespace and operation, or `undefined` if malformed. */
export function parsePermission(
  permission: string
): { namespace: string; operation: string } | undefined {
  const match = SESSION_PERMISSION_PATTERN.exec(permission)
  if (!match || match[1] === undefined || match[2] === undefined) return undefined
  return { namespace: match[1], operation: match[2] }
}

/**
 * Every permission of a contract, required and optional operations alike.
 * Expanded from the contract as passed in, so a grant built from the SDK's
 * copy of `CAPABILITY_CONTRACTS` does not grow when a newer runtime adds an
 * optional operation.
 */
export function capabilityPermissions(contract: CapabilityContract): string[] {
  return [...contract.operations, ...contract.optionalOperations].map((operation) =>
    permissionFor(contract.id, operation)
  )
}

// Entries are only required to be strings here: the open handler checks their
// form, so a malformed permission fails with `SessionGrantInvalidError` like
// any other bad grant rather than with a generic validation error.
export const sessionGrantSchema = z
  .array(z.string())
  .describe(
    'Permissions the session may use, one per operation: "<capability ID>/<operation>", such as ' +
      '"transcription/transcribe", or "runtime/<operation>" for loadModel, downloadAsset, vectorIndex, ' +
      'loggingStream and discoverRpcServers. Omitted: the session is unrestricted. An empty list allows ' +
      'only operations that need no permission. The open fails for a permission the runtime does not have.'
  )

export type SessionGrant = z.infer<typeof sessionGrantSchema>
