import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import prettier from 'prettier'
import { requestSchema, responseSchema } from '@/schemas/common'
import { methodShapes, type MethodName } from '@/server/rpc/method-shapes'

export const contractDir = new URL('../../contract/', import.meta.url)

export const callShapeByHandlerType = {
  reply: 'request-reply',
  stream: 'server-stream',
  duplex: 'duplex'
} as const

type JsonSchema = Record<string, unknown>

/**
 * Wire `type` literal(s) of a request/response schema. Union members all
 * carry the same literal (one method can have several request variants),
 * pipes are read on their input side, intersections on both sides.
 */
function wireTypesOf(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodObject) {
    const typeField: unknown = schema.shape['type']
    if (typeField instanceof z.ZodLiteral) {
      return Array.from(typeField.values as Iterable<unknown>).filter(
        function (value): value is string {
          return typeof value === 'string'
        }
      )
    }
    return []
  }
  if (schema instanceof z.ZodUnion) {
    const nested = (schema.options as readonly unknown[]).flatMap(function (option) {
      return wireTypesOf(option as z.ZodType)
    })
    return [...new Set(nested)]
  }
  if (schema instanceof z.ZodPipe) {
    return wireTypesOf(schema.in as z.ZodType)
  }
  if (schema instanceof z.ZodIntersection) {
    const nested = [
      ...wireTypesOf(schema.def.left as z.ZodType),
      ...wireTypesOf(schema.def.right as z.ZodType)
    ]
    return [...new Set(nested)]
  }
  return []
}

function wireTypeOf(schema: z.ZodType, context: string): string {
  const types = wireTypesOf(schema)
  if (types.length !== 1) {
    throw new Error(
      `Expected exactly one wire "type" literal for ${context}, found: [${types.join(', ')}]`
    )
  }
  return types[0] as string
}

function assertNoRefs(value: unknown, defName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRefs(item, defName)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref') {
        throw new Error(
          `Schema for "${defName}" emitted a $ref (${String(child)}); ` +
            'nesting it under $defs would break the pointer. Extend build-contract.ts to re-root refs.'
        )
      }
      assertNoRefs(child, defName)
    }
  }
}

function toWireJsonSchema(schema: z.ZodType, io: 'input' | 'output', defName: string): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any'
  }) as JsonSchema
  delete json['$schema']
  assertNoRefs(json, defName)
  return json
}

function collectByWireType(
  options: readonly unknown[],
  side: 'request' | 'response'
): Map<string, z.ZodType> {
  const byType = new Map<string, z.ZodType>()
  for (const [index, option] of options.entries()) {
    const schema = option as z.ZodType
    const wireType = wireTypeOf(schema, `${side} union member #${index}`)
    if (byType.has(wireType)) {
      throw new Error(`Duplicate ${side} schema for wire type "${wireType}"`)
    }
    byType.set(wireType, schema)
  }
  return byType
}

function refTo(defName: string): JsonSchema {
  return { $ref: `#/$defs/${defName}` }
}

export function buildContract() {
  const methodNames = (Object.keys(methodShapes) as MethodName[]).sort()
  const requestByType = collectByWireType(requestSchema.options, 'request')
  const responseByType = collectByWireType(responseSchema.options, 'response')

  for (const name of methodNames) {
    if (!requestByType.has(name)) {
      throw new Error(`Method "${name}" has no request schema in the request union`)
    }
    if (!responseByType.has(name)) {
      throw new Error(`Method "${name}" has no response schema in the response union`)
    }
  }
  for (const wireType of requestByType.keys()) {
    if (!methodNames.includes(wireType as MethodName)) {
      throw new Error(`Request schema "${wireType}" has no entry in methodShapes`)
    }
  }

  const responseTypes = [...responseByType.keys()].sort()

  const defs: Record<string, JsonSchema> = {
    request: {
      description: 'Any request accepted by the server, in wire (pre-parse) shape.',
      anyOf: methodNames.map(function (name) {
        return refTo(`${name}.request`)
      })
    },
    response: {
      description:
        'Any response emitted by the server, including progress updates and error envelopes.',
      anyOf: responseTypes.map(function (type) {
        return refTo(`${type}.response`)
      })
    }
  }

  const defEntries: Array<[string, z.ZodType, 'input' | 'output']> = []
  for (const [type, schema] of requestByType) {
    defEntries.push([`${type}.request`, schema, 'input'])
  }
  for (const [type, schema] of responseByType) {
    defEntries.push([`${type}.response`, schema, 'output'])
  }
  defEntries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  for (const [defName, schema, io] of defEntries) {
    defs[defName] = toWireJsonSchema(schema, io, defName)
  }

  const manifest = {
    methods: methodNames.map(function (name) {
      return {
        name,
        callShape: callShapeByHandlerType[methodShapes[name]],
        requestSchema: `schema.json#/$defs/${name}.request`,
        responseSchema: `schema.json#/$defs/${name}.response`
      }
    })
  }

  const schemaDocument = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: '@qvac/sdk wire contract',
    description:
      'Generated from the SDK Zod schemas by `bun run contract:export`. Do not edit by hand. ' +
      'Requests use the schema input shape, responses the output shape; runtime-only ' +
      'refinements and transforms stay server-side.',
    $defs: defs
  }

  return { schemaDocument, manifest }
}

async function formatJson(value: unknown, fileName: string) {
  const filePath = fileURLToPath(new URL(fileName, contractDir))
  const config = await prettier.resolveConfig(filePath)
  return prettier.format(JSON.stringify(value, null, 2), {
    ...config,
    parser: 'json'
  })
}

export async function renderContractFiles() {
  const { schemaDocument, manifest } = buildContract()
  return {
    'schema.json': await formatJson(schemaDocument, 'schema.json'),
    'manifest.json': await formatJson(manifest, 'manifest.json')
  }
}
