import type { z } from 'zod'
import {
  CAPABILITY_CONTRACTS,
  toolCallbackResultSchema,
  vlaHparamsRequestSchema,
  vlaHparamsResponseSchema,
  vlaRunRequestSchema,
  vlaRunResponseSchema,
  vlaSetEmbodimentRequestSchema,
  vlaSetEmbodimentResponseSchema
} from '@qvac/inference/surface'
import { buildContract, callShapeByHandlerType, toWireJsonSchema } from './build-contract'
import type { ContractSnapshot } from './capability-majors'

/**
 * Contract operations that the SDK calls through `pluginInvoke`, so the wire
 * contract has no method for them. Their schemas are the ones the built-in
 * plugin registers for each handler.
 */
const PLUGIN_HANDLER_OPERATIONS: Record<
  string,
  { callShape: keyof typeof callShapeByHandlerType; request: z.ZodType; response: z.ZodType }
> = {
  vlaRun: { callShape: 'reply', request: vlaRunRequestSchema, response: vlaRunResponseSchema },
  vlaHparams: {
    callShape: 'reply',
    request: vlaHparamsRequestSchema,
    response: vlaHparamsResponseSchema
  },
  vlaSetEmbodiment: {
    callShape: 'reply',
    request: vlaSetEmbodimentRequestSchema,
    response: vlaSetEmbodimentResponseSchema
  }
}

/**
 * Operations the runtime implements on top of a contract's operations, keyed by
 * contract ID. No plugin declares them, but their schemas are part of the
 * contract: `completionOrchestrate` runs `completionStream` turns with tool
 * results in between.
 */
const RUNTIME_OPERATIONS: Record<string, string[]> = {
  completion: ['completionOrchestrate']
}

/**
 * The frames a client sends up a duplex call after the request, for the
 * operations whose frames have a schema. The other duplex operations take raw
 * audio or text chunks. The wire contract does not describe these frames, so
 * the baseline records them here.
 */
const DUPLEX_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  completionOrchestrate: toolCallbackResultSchema
}

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
      optionalOperations: [...contract.optionalOperations],
      runtimeOperations: [...(RUNTIME_OPERATIONS[contract.id] ?? [])]
    }))
    .sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1))

  const operations = new Set(
    contracts.flatMap((contract) => [
      ...contract.operations,
      ...contract.optionalOperations,
      ...contract.runtimeOperations
    ])
  )
  const { schemaDocument, manifest } = buildContract({ markStrict: true })
  const wireMethods = manifest.methods.filter((method) => operations.has(method.name))
  const wireNames = new Set<string>(wireMethods.map((method) => method.name))

  const methods: ContractSnapshot['manifest']['methods'] = wireMethods.map((method) => ({
    name: method.name as string,
    callShape: method.callShape as string,
    requestSchema: method.requestSchema,
    responseSchema: method.responseSchema,
    ...(method.progress && { progress: { responseSchema: method.progress.responseSchema } })
  }))
  const $defs: Record<string, unknown> = {}
  for (const method of methods) {
    for (const ref of [
      method.requestSchema,
      method.responseSchema,
      method.progress?.responseSchema
    ]) {
      if (ref === undefined) continue
      const name = ref.slice(ref.indexOf('#/$defs/') + '#/$defs/'.length)
      $defs[name] = schemaDocument.$defs[name as keyof typeof schemaDocument.$defs]
    }
  }

  for (const operation of [...operations].sort()) {
    if (wireNames.has(operation)) continue
    const handler = PLUGIN_HANDLER_OPERATIONS[operation]
    if (!handler) {
      throw new Error(
        `capability operation "${operation}" has no wire method and no entry in PLUGIN_HANDLER_OPERATIONS, so its schemas cannot be compared across releases`
      )
    }
    const requestDef = `${operation}.request`
    const responseDef = `${operation}.response`
    $defs[requestDef] = toWireJsonSchema(handler.request, 'input', requestDef, { markStrict: true })
    $defs[responseDef] = toWireJsonSchema(handler.response, 'output', responseDef, {
      markStrict: true
    })
    methods.push({
      name: operation,
      callShape: callShapeByHandlerType[handler.callShape],
      requestSchema: `schema.json#/$defs/${requestDef}`,
      responseSchema: `schema.json#/$defs/${responseDef}`
    })
  }
  for (const [operation, schema] of Object.entries(DUPLEX_INPUT_SCHEMAS)) {
    const method = methods.find((candidate) => candidate.name === operation)
    if (!method) throw new Error(`duplex input schema for "${operation}", which no contract lists`)
    const inputDef = `${operation}.input`
    $defs[inputDef] = toWireJsonSchema(schema, 'input', inputDef, { markStrict: true })
    method.inputSchema = `schema.json#/$defs/${inputDef}`
  }
  methods.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    capabilities: { contracts },
    manifest: { methods },
    schema: { $defs }
  }
}
