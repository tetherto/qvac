import { CAPABILITY_CONTRACTS } from '@qvac/inference/surface'
import { buildContract } from './build-contract'
import type { ContractSnapshot } from './capability-majors'

/**
 * The capability baseline: the QVAC capability contract table, and the call
 * shape and wire schemas of every operation the contracts list. `npm run build`
 * writes it to `dist/contract/capability-baseline.json`, so each published
 * package carries the contracts it was released with, and
 * `check-capability-majors.ts` compares the working tree against the one in
 * the last published package.
 *
 * Strict objects carry `x-strict: true`: clients reject unknown fields in them,
 * so a new response field there is a break.
 */
export function buildCapabilityBaseline(): ContractSnapshot {
  const contracts = Object.values(CAPABILITY_CONTRACTS)
    .map((contract) => ({
      id: contract.id,
      version: contract.version,
      operations: [...contract.operations],
      optionalOperations: [...contract.optionalOperations]
    }))
    .sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1))

  const operations = new Set(
    contracts.flatMap((contract) => [...contract.operations, ...contract.optionalOperations])
  )
  const { schemaDocument, manifest } = buildContract({ markStrict: true })
  const methods = manifest.methods.filter((method) => operations.has(method.name))
  const defNames = methods.flatMap((method) =>
    [method.requestSchema, method.responseSchema, method.progress?.responseSchema]
      .filter((ref): ref is string => ref !== undefined)
      .map((ref) => ref.slice(ref.indexOf('#/$defs/') + '#/$defs/'.length))
  )
  const $defs = Object.fromEntries(
    defNames.map((name) => [name, schemaDocument.$defs[name as keyof typeof schemaDocument.$defs]])
  )

  return {
    capabilities: { contracts },
    manifest: {
      methods: methods.map((method) => ({
        name: method.name,
        callShape: method.callShape,
        requestSchema: method.requestSchema,
        responseSchema: method.responseSchema,
        ...(method.progress && { progress: { responseSchema: method.progress.responseSchema } })
      }))
    },
    schema: { $defs }
  }
}
