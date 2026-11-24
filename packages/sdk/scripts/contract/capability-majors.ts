import { findIncompatibility, type Definitions } from './schema-compat'

/**
 * Compares the capability contracts of a published SDK with the working tree.
 * A contract whose major is unchanged must stay compatible for its callers:
 * every published operation is still there, a required operation stays
 * required, no operation becomes newly required, the call shape is the same,
 * requests the old schema accepted are still accepted, and responses still fit
 * the old schema. A higher major for the same ID is a deliberate break and is
 * not compared.
 */

interface ManifestMethod {
  name: string
  callShape: string
  requestSchema: string
  responseSchema: string
  progress?: { responseSchema: string } | undefined
}

export interface CapabilityContractEntry {
  id: string
  version: number
  operations: string[]
  optionalOperations: string[]
}

/** The shape of `capability-baseline.json`, and of the working tree's contracts. */
export interface ContractSnapshot {
  capabilities: { contracts: CapabilityContractEntry[] }
  manifest: { methods: ManifestMethod[] }
  schema: { $defs: Definitions }
}

function defName(ref: string): string {
  return ref.slice(ref.indexOf('#/$defs/') + '#/$defs/'.length)
}

function schemaAt(snapshot: ContractSnapshot, ref: string): unknown {
  return snapshot.schema.$defs[defName(ref)]
}

export function findMajorProblems(
  published: ContractSnapshot,
  current: ContractSnapshot
): string[] {
  const problems: string[] = []
  const currentMethods = new Map(current.manifest.methods.map((method) => [method.name, method]))
  const publishedMethods = new Map(
    published.manifest.methods.map((method) => [method.name, method])
  )

  for (const before of published.capabilities.contracts) {
    const key = `${before.id}@${before.version}`
    const after = current.capabilities.contracts.find(
      (contract) => contract.id === before.id && contract.version === before.version
    )
    if (!after) {
      const bumped = current.capabilities.contracts.some(
        (contract) => contract.id === before.id && contract.version > before.version
      )
      if (!bumped) problems.push(`${key} was published and is no longer defined`)
      continue
    }

    for (const operation of before.operations) {
      if (after.operations.includes(operation)) continue
      problems.push(
        after.optionalOperations.includes(operation)
          ? `${key}: required operation ${operation} became optional`
          : `${key}: operation ${operation} was removed`
      )
    }
    for (const operation of before.optionalOperations) {
      if (!after.operations.includes(operation) && !after.optionalOperations.includes(operation)) {
        problems.push(`${key}: optional operation ${operation} was removed`)
      }
    }
    for (const operation of after.operations) {
      if (before.operations.includes(operation)) continue
      problems.push(
        before.optionalOperations.includes(operation)
          ? `${key}: optional operation ${operation} became required`
          : `${key}: new required operation ${operation}`
      )
    }

    const kept = [...before.operations, ...before.optionalOperations].filter(
      (operation) =>
        after.operations.includes(operation) || after.optionalOperations.includes(operation)
    )
    for (const operation of kept) {
      const old = publishedMethods.get(operation)
      const now = currentMethods.get(operation)
      // buildCapabilityBaseline records every operation, so a missing entry is
      // a baseline written before the operation's schemas were recorded.
      if (!old || !now) continue
      if (old.callShape !== now.callShape) {
        problems.push(`${key}: ${operation} changed from ${old.callShape} to ${now.callShape}`)
        continue
      }
      const request = findIncompatibility(
        schemaAt(published, old.requestSchema),
        published.schema.$defs,
        schemaAt(current, now.requestSchema),
        current.schema.$defs,
        { direction: 'request' }
      )
      if (request) problems.push(`${key}: ${operation} request: ${request}`)
      const responses: Array<[string, string | undefined, string | undefined]> = [
        ['response', old.responseSchema, now.responseSchema],
        ['progress response', old.progress?.responseSchema, now.progress?.responseSchema]
      ]
      for (const [label, oldRef, nowRef] of responses) {
        if (oldRef === undefined && nowRef === undefined) continue
        if (oldRef === undefined || nowRef === undefined) {
          problems.push(`${key}: ${operation} ${label} was ${oldRef ? 'removed' : 'added'}`)
          continue
        }
        const response = findIncompatibility(
          schemaAt(current, nowRef),
          current.schema.$defs,
          schemaAt(published, oldRef),
          published.schema.$defs,
          { direction: 'response' }
        )
        if (response) problems.push(`${key}: ${operation} ${label}: ${response}`)
      }
    }
  }
  return problems
}
