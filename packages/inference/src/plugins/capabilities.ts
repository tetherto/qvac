import type { QvacPlugin } from '@/schemas/plugin'
import {
  findQvacCapabilityContract,
  type CapabilityContract,
  type RuntimeCapability
} from '@/schemas/capabilities'

function contractKey(contract: CapabilityContract): string {
  return `${contract.id}@${contract.version}`
}

function hasHandler(plugin: QvacPlugin, operation: string): boolean {
  return Object.prototype.hasOwnProperty.call(plugin.handlers, operation)
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function sameOperations(a: CapabilityContract, b: CapabilityContract): boolean {
  const same = (x: readonly string[], y: readonly string[]) => {
    const sortedY = sorted(y)
    return x.length === y.length && sorted(x).every((value, index) => value === sortedY[index])
  }
  return same(a.operations, b.operations) && same(a.optionalOperations, b.optionalOperations)
}

function describeOperations(contract: CapabilityContract): string {
  const optional = contract.optionalOperations.length
    ? `, optional [${contract.optionalOperations.join(', ')}]`
    : ''
  return `required [${contract.operations.join(', ')}]${optional}`
}

/**
 * Checks a plugin's `provides` against the contract table, its own handlers
 * and the plugins already registered. Returns the reason the declaration is
 * invalid, or `undefined` when it is valid. The runtime schema has already
 * checked each contract's shape, ID format and version.
 */
export function findProvidesProblem(
  plugin: QvacPlugin,
  registered: Iterable<QvacPlugin>
): string | undefined {
  const provides = plugin.provides ?? []
  const declared = new Set<string>()
  const contractIdByHandler = new Map<string, string>()

  for (const contract of provides) {
    const key = contractKey(contract)
    if (declared.has(key)) return `provides lists capability "${key}" twice`
    declared.add(key)

    const operations = [...contract.operations, ...contract.optionalOperations]
    if (new Set(operations).size !== operations.length) {
      return `capability "${key}" lists an operation more than once`
    }

    if (!contract.id.includes('.')) {
      const qvacContract = findQvacCapabilityContract(contract.id, contract.version)
      if (!qvacContract) {
        return (
          `capability "${key}" is not a QVAC capability contract; ` +
          'a contract QVAC does not define needs a dotted ID such as "acme.diarization"'
        )
      }
      if (!sameOperations(contract, qvacContract)) {
        return (
          `capability "${key}" declares ${describeOperations(contract)}, ` +
          `but the QVAC contract has ${describeOperations(qvacContract)}`
        )
      }
    } else {
      const problem = findThirdPartyConflict(contract, registered)
      if (problem) return problem
    }

    const missing = contract.operations.filter((operation) => !hasHandler(plugin, operation))
    if (missing.length > 0) {
      return `capability "${key}" requires handlers that are missing: ${missing.join(', ')}`
    }

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

// Two plugins that provide one third-party contract must agree on its
// operations, or the report could not say what the contract contains.
function findThirdPartyConflict(
  contract: CapabilityContract,
  registered: Iterable<QvacPlugin>
): string | undefined {
  for (const other of registered) {
    const match = (other.provides ?? []).find(
      (candidate) => candidate.id === contract.id && candidate.version === contract.version
    )
    if (match && !sameOperations(contract, match)) {
      return (
        `capability "${contractKey(contract)}" declares ${describeOperations(contract)}, ` +
        `but plugin "${other.modelType}" declares ${describeOperations(match)}`
      )
    }
  }
  return undefined
}

/**
 * The capability contracts the given plugins provide, one entry per ID and
 * major, sorted by ID and then version. An optional operation is in
 * `operations` when every provider of the contract has a handler for it, and
 * in `partialOperations` when only some do.
 */
export function collectRuntimeCapabilities(plugins: Iterable<QvacPlugin>): RuntimeCapability[] {
  const groups = new Map<string, { contract: CapabilityContract; providers: QvacPlugin[] }>()
  for (const plugin of plugins) {
    for (const contract of plugin.provides ?? []) {
      const key = contractKey(contract)
      const group = groups.get(key)
      if (group) group.providers.push(plugin)
      else groups.set(key, { contract, providers: [plugin] })
    }
  }

  const capabilities = Array.from(groups.values(), ({ contract, providers }) => {
    const operations = [...contract.operations]
    const partialOperations: string[] = []
    for (const operation of contract.optionalOperations) {
      const count = providers.filter((plugin) => hasHandler(plugin, operation)).length
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
