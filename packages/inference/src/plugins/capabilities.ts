import type { PluginHandlerDefinition, QvacPlugin } from '@/schemas/plugin'
import {
  findQvacCapabilityContract,
  type CapabilityContract,
  type CapabilityDeclaration,
  type RuntimeCapability
} from '@/schemas/capabilities'

export type OperationCallShape = 'reply' | 'stream' | 'duplex'

/**
 * How the runtime calls each operation of a QVAC contract. A typed request
 * follows its entry in the request registry; the VLA operations are reached
 * through `pluginInvoke`, which calls a reply handler. A handler with another
 * shape fails every call with `PluginHandlerTypeMismatchError`, so
 * registration rejects it.
 */
export const QVAC_OPERATION_CALL_SHAPES: Readonly<Record<string, OperationCallShape>> =
  Object.freeze({
    completionStream: 'stream',
    batchCompletionStream: 'stream',
    calcTokens: 'reply',
    finetune: 'reply',
    translate: 'stream',
    embed: 'reply',
    embedBatch: 'reply',
    rerank: 'reply',
    decide: 'reply',
    classify: 'stream',
    transcribe: 'stream',
    transcribeStream: 'duplex',
    bciTranscribe: 'stream',
    bciTranscribeStream: 'duplex',
    textToSpeech: 'stream',
    textToSpeechStream: 'duplex',
    ocrStream: 'stream',
    diffusionStream: 'stream',
    upscaleStream: 'stream',
    videoStream: 'stream',
    worldStepStream: 'stream',
    worldSceneStream: 'stream',
    audioGenStream: 'stream',
    audioEditStream: 'stream',
    audioUnderstand: 'stream',
    vlaRun: 'reply',
    vlaHparams: 'reply',
    vlaSetEmbodiment: 'reply'
  })

export function handlerCallShape(handler: PluginHandlerDefinition): OperationCallShape {
  if (handler.duplex) return 'duplex'
  return handler.streaming ? 'stream' : 'reply'
}

function contractKey(contract: { id: string; version: number }): string {
  return `${contract.id}@${contract.version}`
}

function isQvacId(id: string): boolean {
  return !id.includes('.')
}

function getHandler(plugin: QvacPlugin, operation: string): PluginHandlerDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(plugin.handlers, operation)
    ? plugin.handlers[operation]
    : undefined
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b)
  return a.length === set.size && a.every((value) => set.has(value))
}

function list(values: readonly string[]): string {
  return `[${[...values].sort().join(', ')}]`
}

/**
 * The contract a declaration stands for: the runtime's own table entry for a
 * QVAC ID, whatever lists the plugin carries, or the declared lists for a
 * dotted ID. A string is the reason the declaration cannot be resolved.
 */
export function resolveCapabilityDeclaration(
  declaration: CapabilityDeclaration
): CapabilityContract | string {
  const key = contractKey(declaration)
  if (isQvacId(declaration.id)) {
    return (
      findQvacCapabilityContract(declaration.id, declaration.version) ??
      `capability "${key}" is not a QVAC capability contract; ` +
        'a contract QVAC does not define needs a dotted ID such as "acme.diarization"'
    )
  }
  if (!declaration.operations) {
    return `capability "${key}" is not defined by QVAC, so it must list its operations`
  }
  return {
    id: declaration.id,
    version: declaration.version,
    operations: declaration.operations,
    optionalOperations: declaration.optionalOperations ?? []
  }
}

/**
 * Checks a plugin's `provides` against the contract table, its own handlers
 * and the plugins already registered. Returns the reason the declaration is
 * invalid, or `undefined` when it is valid. The runtime schema has already
 * checked each declaration's shape, ID format and version.
 */
export function findProvidesProblem(
  plugin: QvacPlugin,
  registered: Iterable<QvacPlugin>
): string | undefined {
  const others = [...registered]
  const declared = new Set<string>()
  const contractIdByHandler = new Map<string, string>()

  for (const declaration of plugin.provides ?? []) {
    const key = contractKey(declaration)
    if (declared.has(key)) return `provides lists capability "${key}" twice`
    declared.add(key)

    const contract = resolveCapabilityDeclaration(declaration)
    if (typeof contract === 'string') return contract

    const operations = [...contract.operations, ...contract.optionalOperations]
    if (new Set(operations).size !== operations.length) {
      return `capability "${key}" lists an operation more than once`
    }

    const missing = contract.operations.filter((operation) => !getHandler(plugin, operation))
    if (missing.length > 0) {
      return `capability "${key}" requires handlers that are missing: ${missing.join(', ')}`
    }

    const problem = isQvacId(contract.id)
      ? findQvacCallShapeProblem(plugin, contract)
      : findThirdPartyConflict(plugin, contract, others)
    if (problem) return problem

    for (const operation of operations) {
      const owner = contractIdByHandler.get(operation)
      if (owner !== undefined && owner !== contract.id) {
        return `handler "${operation}" is listed by capabilities "${owner}" and "${contract.id}"`
      }
      contractIdByHandler.set(operation, contract.id)
    }
  }

  return undefined
}

function findQvacCallShapeProblem(
  plugin: QvacPlugin,
  contract: CapabilityContract
): string | undefined {
  for (const operation of [...contract.operations, ...contract.optionalOperations]) {
    const handler = getHandler(plugin, operation)
    const expected = QVAC_OPERATION_CALL_SHAPES[operation]
    if (!handler || !expected) continue
    const actual = handlerCallShape(handler)
    if (actual !== expected) {
      return (
        `handler "${operation}" of capability "${contractKey(contract)}" is a ${actual} handler, ` +
        `but the runtime calls ${operation} as a ${expected}`
      )
    }
  }
  return undefined
}

// Providers of one third-party contract must agree on its required operations
// and on how each shared operation is called, or a consumer written against
// one provider fails on another. Optional operations may differ, so a newer
// provider can add one under the same major. Call shapes are compared over
// both providers' lists: the report counts any handler with an optional
// operation's name, whichever provider listed it, so checking only the
// incoming provider's lists would make the result depend on registration order.
function findThirdPartyConflict(
  plugin: QvacPlugin,
  contract: CapabilityContract,
  registered: readonly QvacPlugin[]
): string | undefined {
  const key = contractKey(contract)
  for (const other of registered) {
    const match = (other.provides ?? []).find(
      (candidate) => candidate.id === contract.id && candidate.version === contract.version
    )
    if (!match) continue
    const otherRequired = match.operations ?? []
    if (!sameSet(contract.operations, otherRequired)) {
      return (
        `capability "${key}" requires ${list(contract.operations)}, ` +
        `but plugin "${other.modelType}" requires ${list(otherRequired)}`
      )
    }
    const operations = new Set([
      ...contract.operations,
      ...contract.optionalOperations,
      ...otherRequired,
      ...(match.optionalOperations ?? [])
    ])
    for (const operation of operations) {
      const handler = getHandler(plugin, operation)
      const otherHandler = getHandler(other, operation)
      if (!handler || !otherHandler) continue
      const actual = handlerCallShape(handler)
      const expected = handlerCallShape(otherHandler)
      if (actual !== expected) {
        return (
          `handler "${operation}" of capability "${key}" is a ${actual} handler, ` +
          `but plugin "${other.modelType}" serves it as a ${expected} handler`
        )
      }
    }
  }
  return undefined
}

/**
 * The capability contracts the given plugins declare, one entry per ID and
 * major, sorted by ID and then version. A QVAC contract's operations come
 * from the runtime's table; a third-party contract's optional operations are
 * those any provider lists. An optional operation is in `operations` when
 * every provider of the contract has a handler for it, and in
 * `partialOperations` when only some do.
 */
export function collectRuntimeCapabilities(plugins: Iterable<QvacPlugin>): RuntimeCapability[] {
  const groups = new Map<
    string,
    { contract: CapabilityContract; optional: Set<string>; providers: QvacPlugin[] }
  >()
  for (const plugin of plugins) {
    for (const declaration of plugin.provides ?? []) {
      const contract = resolveCapabilityDeclaration(declaration)
      if (typeof contract === 'string') continue
      const key = contractKey(contract)
      const group = groups.get(key)
      if (group) {
        group.providers.push(plugin)
        for (const operation of contract.optionalOperations) group.optional.add(operation)
      } else {
        groups.set(key, {
          contract,
          optional: new Set(contract.optionalOperations),
          providers: [plugin]
        })
      }
    }
  }

  const capabilities = Array.from(groups.values(), ({ contract, optional, providers }) => {
    const operations = [...contract.operations]
    const partialOperations: string[] = []
    for (const operation of optional) {
      const count = providers.filter((plugin) => getHandler(plugin, operation)).length
      if (count === providers.length) operations.push(operation)
      else if (count > 0) partialOperations.push(operation)
    }
    return {
      id: contract.id,
      version: contract.version,
      operations: operations.sort(),
      partialOperations: partialOperations.sort()
    }
  })

  return capabilities.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1))
}
