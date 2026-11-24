import type { Request } from '@/schemas/common'
import { CAPABILITY_CONTRACTS } from '@/schemas/capabilities'
import {
  RUNTIME_PERMISSION_NAMESPACE,
  RUNTIME_PERMISSION_OPERATIONS,
  parsePermission,
  permissionFor
} from '@/schemas/session-grants'
import { CapabilityNotGrantedError, SessionGrantInvalidError } from '@/errors/index'
import { getAllPlugins, getPlugin } from '@/plugins/registry'
import { resolveCapabilityDeclaration } from '@/plugins/capabilities'
import { getModelEntry } from '@/runtime/model-registry'
import { getSessionGrant } from '@/runtime/session-registry'

type RequestType = Request['type']

/**
 * How a request type is checked for a session with a grant:
 * - `capability`: the permission of the QVAC contract operation of the same name;
 * - `{ operation }`: the permission of that QVAC contract operation;
 * - `pluginInvoke`: the permission of the contract that lists the handler on the model's plugin;
 * - `runtime`: the permission `runtime/<request type>`;
 * - `free`: no permission;
 * - `ownerOnly`: refused from every session before this check, by `assertOwnerOperation`
 *   or, for the session methods, by the session handlers.
 */
type GrantRule =
  'capability' | { operation: string } | 'pluginInvoke' | 'runtime' | 'free' | 'ownerOnly'

const GRANT_RULES = {
  completionStream: 'capability',
  completionOrchestrate: { operation: 'completionStream' },
  batchCompletionStream: 'capability',
  calcTokens: 'capability',
  finetune: 'capability',
  translate: 'capability',
  embed: 'capability',
  embedBatch: 'capability',
  rerank: 'capability',
  decide: 'capability',
  classify: 'capability',
  transcribe: 'capability',
  transcribeStream: 'capability',
  bciTranscribe: 'capability',
  bciTranscribeStream: 'capability',
  textToSpeech: 'capability',
  textToSpeechStream: 'capability',
  ocrStream: 'capability',
  estimateDisparity: 'capability',
  diffusionStream: 'capability',
  upscaleStream: 'capability',
  videoStream: 'capability',
  worldStepStream: 'capability',
  worldSceneStream: 'capability',
  audioGenStream: 'capability',
  audioEditStream: 'capability',
  audioUnderstand: 'capability',

  pluginInvoke: 'pluginInvoke',
  pluginInvokeStream: 'pluginInvoke',

  loadModel: 'runtime',
  downloadAsset: 'runtime',
  vectorIndex: 'runtime',
  loggingStream: 'runtime',
  discoverRpcServers: 'runtime',

  closeSession: 'free',
  cancel: 'free',
  heartbeat: 'free',
  state: 'free',
  getRuntimeCapabilities: 'free',
  unloadModel: 'free',
  getModelInfo: 'free',
  getLoadedModelInfo: 'free',
  getSystemResources: 'free',
  assessModelFit: 'free',
  modelRegistryList: 'free',
  modelRegistrySearch: 'free',
  modelRegistryGetModel: 'free',

  openSession: 'ownerOnly',
  suspend: 'ownerOnly',
  resume: 'ownerOnly',
  deleteCache: 'ownerOnly',
  startRpcServer: 'ownerOnly',
  stopRpcServer: 'ownerOnly'
} as const satisfies Record<RequestType, GrantRule>

/** The rule for every request type, for tests that hold the table to the request schemas. */
export const SESSION_GRANT_RULES: Readonly<Record<RequestType, GrantRule>> = GRANT_RULES

const QVAC_OPERATION_PERMISSIONS: ReadonlyMap<string, string> = new Map(
  Object.values(CAPABILITY_CONTRACTS).flatMap((contract) =>
    [...contract.operations, ...contract.optionalOperations].map(
      (operation) => [operation, permissionFor(contract.id, operation)] as const
    )
  )
)

/** The permission of a QVAC contract operation, or `undefined` when no QVAC contract lists it. */
export function qvacOperationPermission(operation: string): string | undefined {
  return QVAC_OPERATION_PERMISSIONS.get(operation)
}

/**
 * Every permission a grant may name on this runtime: the runtime operations,
 * and each operation of every contract a registered plugin declares, QVAC
 * contracts resolved from the runtime's own table.
 */
function availablePermissions(): Set<string> {
  const available = new Set(
    RUNTIME_PERMISSION_OPERATIONS.map((operation) =>
      permissionFor(RUNTIME_PERMISSION_NAMESPACE, operation)
    )
  )
  for (const plugin of getAllPlugins()) {
    for (const declaration of plugin.provides ?? []) {
      const contract = resolveCapabilityDeclaration(declaration)
      if (typeof contract === 'string') continue
      for (const operation of [...contract.operations, ...contract.optionalOperations]) {
        available.add(permissionFor(contract.id, operation))
      }
    }
  }
  return available
}

/**
 * Checks a grant before its session opens. Plugins register at startup and do
 * not change afterwards, so a permission the runtime lacks now never becomes
 * usable, and naming one is a mistake to report rather than ignore.
 */
export function assertSessionGrantValid(sessionId: string, grant: readonly string[]): void {
  const seen = new Set<string>()
  const available = availablePermissions()
  for (const permission of grant) {
    const parsed = parsePermission(permission)
    if (!parsed) {
      throw new SessionGrantInvalidError(
        sessionId,
        permission,
        `"${permission}" is not "<capability ID>/<operation>" or "runtime/<operation>"`
      )
    }
    if (seen.has(permission)) {
      throw new SessionGrantInvalidError(sessionId, permission, `"${permission}" is listed twice`)
    }
    seen.add(permission)
    if (available.has(permission)) continue
    const reason =
      parsed.namespace === RUNTIME_PERMISSION_NAMESPACE
        ? `"${parsed.operation}" is not a runtime operation that takes a permission; those are ${RUNTIME_PERMISSION_OPERATIONS.join(', ')}`
        : `no registered plugin declares the operation "${parsed.operation}" of capability "${parsed.namespace}"`
    throw new SessionGrantInvalidError(sessionId, permission, reason)
  }
}

/**
 * The permission a plugin invoke needs: the one of the contract that lists the
 * handler among the model's plugin's own declarations. `null` when no
 * declaration lists it; `undefined` when the model, plugin or handler is
 * missing, so the invoke fails on that exactly as it does without a grant.
 */
function pluginInvokePermission(modelId: string, handler: string): string | null | undefined {
  const model = getModelEntry(modelId)
  if (!model) return undefined
  const plugin = getPlugin(model.local.modelType)
  if (!plugin || !Object.prototype.hasOwnProperty.call(plugin.handlers, handler)) return undefined
  for (const declaration of plugin.provides ?? []) {
    const contract = resolveCapabilityDeclaration(declaration)
    if (typeof contract === 'string') continue
    if ([...contract.operations, ...contract.optionalOperations].includes(handler)) {
      return permissionFor(contract.id, handler)
    }
  }
  return null
}

/**
 * Refuses a request from a session with a grant when the grant does not cover
 * it. The owner, unrestricted sessions and sessions that are not open pass;
 * the open-session and owner-only checks run before this one.
 */
export function assertSessionGrant(request: Request): void {
  const { sessionId } = request
  if (sessionId === undefined) return
  const grant = getSessionGrant(sessionId)
  if (!grant) return

  const rule: GrantRule = GRANT_RULES[request.type]
  let operation: string = request.type
  let required: string | null | undefined

  if (rule === 'free' || rule === 'ownerOnly') return
  if (rule === 'runtime') {
    required = permissionFor(RUNTIME_PERMISSION_NAMESPACE, request.type)
  } else if (rule === 'pluginInvoke') {
    const invoke = request as { modelId: string; handler: string }
    operation = invoke.handler
    required = pluginInvokePermission(invoke.modelId, invoke.handler)
    if (required === undefined) return
  } else {
    const contractOperation = rule === 'capability' ? request.type : rule.operation
    required = qvacOperationPermission(contractOperation) ?? null
  }

  if (required !== null && grant.has(required)) return
  throw new CapabilityNotGrantedError(operation, sessionId, required)
}
