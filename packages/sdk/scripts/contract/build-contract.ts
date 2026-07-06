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

function mergeObjectSchemaParts(parts: JsonSchema[], defName: string): JsonSchema {
  const properties: JsonSchema = {}
  const required: string[] = []
  for (const part of parts) {
    if (part['type'] !== undefined && part['type'] !== 'object') {
      throw new Error(`Cannot merge a non-object schema member while flattening "${defName}"`)
    }
    for (const [key, value] of Object.entries((part['properties'] as JsonSchema) ?? {})) {
      if (key in properties && JSON.stringify(properties[key]) !== JSON.stringify(value)) {
        throw new Error(
          `Conflicting definitions for property "${key}" while flattening "${defName}"`
        )
      }
      properties[key] = value
    }
    for (const name of (part['required'] as string[] | undefined) ?? []) {
      if (!required.includes(name)) required.push(name)
    }
  }
  return { type: 'object', properties, required }
}

/**
 * Flattens `allOf: [commonFields, { oneOf/anyOf: [...variants] }]` (Zod's
 * `.and()` of an object with a discriminated union) into a plain
 * `oneOf`/`anyOf` with `commonFields` merged into every variant.
 *
 * Needed because JSON-Schema-consuming codegen (verified against
 * datamodel-code-generator, the standard JSON-Schema -> pydantic tool) does
 * not merge `allOf` branches when one of them is itself a union: it silently
 * keeps only the first branch under the schema's title, dropping every
 * variant-specific field. `allOf`-of-a-union is valid JSON Schema, but this
 * is a known rough edge across JSON-Schema tooling generally, so flattening
 * it here makes the contract more robust for every consumer, not a
 * Python-specific workaround.
 *
 * Scoped to the one shape currently in use (exactly one `allOf` branch is a
 * union, the rest are plain object schemas): anything else throws instead of
 * silently emitting a schema some consumer will mis-generate from.
 */
function flattenAllOfWithUnion(json: JsonSchema, defName: string): JsonSchema {
  const allOf = json['allOf']
  if (!Array.isArray(allOf)) return json

  const isUnionMember = function (member: unknown): member is JsonSchema {
    return (
      member !== null &&
      typeof member === 'object' &&
      (Array.isArray((member as JsonSchema)['oneOf']) ||
        Array.isArray((member as JsonSchema)['anyOf']))
    )
  }
  const unionMembers = (allOf as JsonSchema[]).filter(isUnionMember)
  const plainMembers = (allOf as JsonSchema[]).filter(function (member) {
    return !isUnionMember(member)
  })

  if (unionMembers.length !== 1) {
    throw new Error(
      `Schema for "${defName}" uses allOf with ${unionMembers.length} union branches; ` +
        'only the single-union-branch shape is handled. Extend flattenAllOfWithUnion in build-contract.ts.'
    )
  }
  const unionMember = unionMembers[0] as JsonSchema
  const unionKey = Array.isArray(unionMember['oneOf']) ? 'oneOf' : 'anyOf'
  const arms = unionMember[unionKey] as JsonSchema[]

  const flattened: JsonSchema = { ...json }
  delete flattened['allOf']
  flattened[unionKey] = arms.map(function (arm) {
    return mergeObjectSchemaParts([...plainMembers, arm], defName)
  })
  return flattened
}

function isSchemaObject(node: unknown): node is JsonSchema {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
}

function unionArmsOf(node: JsonSchema): JsonSchema[] | undefined {
  if (Array.isArray(node['oneOf'])) return node['oneOf'] as JsonSchema[]
  if (Array.isArray(node['anyOf'])) return node['anyOf'] as JsonSchema[]
  return undefined
}

/**
 * Property key that best discriminates a set of sibling union arms: the
 * `const` string field, wherever present, that splits the arms into the most
 * distinct groups. Picks the *best* key rather than requiring perfection —
 * two shortcomings otherwise cause bad names:
 *
 * - Requiring every arm to carry the key: `loadModel`'s custom-plugin
 *   catch-all arm has no `modelType` const, so demanding full coverage threw
 *   away `modelType` for the other 11 arms too.
 * - Requiring the value to never repeat: `completionStream`'s event union
 *   has two arms both typed `completionDone` (success vs. error), so
 *   demanding perfect uniqueness rejected `type` for all 8 events, even
 *   though it cleanly separates the other 6. A same-named pair among many
 *   otherwise-unique arms still bumps to `...2` via `ensureUniqueTitle`
 *   downstream — better than every arm losing its name to that one clash.
 *
 * Also deliberately not a fixed guess-list of names (`type`/`operation`/...):
 * the wire method discriminator (`type`) is IDENTICAL across every arm of a
 * single method's own operation union (e.g. every `rag` arm has
 * `type: 'rag'`), so guessing by name picked the one field that never
 * discriminates anything and produced `RagRequestRag`, `RagRequestRag2`, ...
 * A key with only one distinct value across all arms is rejected outright —
 * it's exactly this "same value everywhere" case.
 */
function pickDiscriminatorKey(arms: JsonSchema[]): string | undefined {
  const candidateKeys = new Set<string>()
  for (const arm of arms) {
    const properties = arm['properties']
    if (isSchemaObject(properties)) {
      for (const key of Object.keys(properties)) candidateKeys.add(key)
    }
  }
  let bestKey: string | undefined
  let bestGroupCount = 1 // a key with only 1 distinct value discriminates nothing
  for (const key of candidateKeys) {
    const values: string[] = []
    for (const arm of arms) {
      const properties = arm['properties']
      const field = isSchemaObject(properties) ? properties[key] : undefined
      if (isSchemaObject(field) && typeof field['const'] === 'string') {
        values.push(field['const'])
      }
    }
    const groupCount = new Set(values).size
    if (groupCount > bestGroupCount) {
      bestKey = key
      bestGroupCount = groupCount
    }
  }
  return bestKey
}

function ensureUniqueTitle(base: string, seenTitles: Set<string>): string {
  if (!seenTitles.has(base)) {
    seenTitles.add(base)
    return base
  }
  let suffix = 2
  while (seenTitles.has(`${base}${suffix}`)) suffix++
  const unique = `${base}${suffix}`
  seenTitles.add(unique)
  return unique
}

/** Names each arm of a union: by the shared discriminator's value when the
 * arms have one in common, else positionally (1-based, index 0 unsuffixed). */
function nameUnionArms(arms: JsonSchema[], namePrefix: string): string[] {
  const key = pickDiscriminatorKey(arms)
  return arms.map(function (arm, index) {
    const properties = isSchemaObject(arm) ? arm['properties'] : undefined
    const field = key && isSchemaObject(properties) ? properties[key] : undefined
    const discriminator = isSchemaObject(field) ? (field['const'] as string | undefined) : undefined
    return discriminator
      ? `${namePrefix}${toPascalCase(discriminator)}`
      : `${namePrefix}${index + 1}`
  })
}

/**
 * Assigns a `title` to `node` (unless it already has one) and recurses into
 * its properties/items/union arms, naming each by its property key or (for
 * discriminated union arms) the arm's discriminator value — e.g.
 * `completionStream.response`'s event union gets
 * `CompletionStreamResponseEventsItemContentDelta` instead of a bare `Events3`.
 *
 * Without this, nested/inline Zod schemas reach Python codegen (verified
 * against datamodel-code-generator) as positionally-numbered classes
 * (`Stats13`, `Events7`) with no indication of what they represent.
 *
 * If `node` already carries a `title` (a schema author's explicit Zod
 * `.meta({ title: ... })`, e.g. `FinetuneRunRequest`), that title wins over
 * `namePrefix` — both for `node` itself and as the prefix for its own
 * children — instead of being silently discarded the moment `node` also
 * happens to be a union wrapper.
 */
function titleSchemaNode(node: unknown, namePrefix: string, seenTitles: Set<string>): void {
  if (!isSchemaObject(node)) return

  const existingTitle = typeof node['title'] === 'string' ? node['title'] : undefined
  if (existingTitle) seenTitles.add(existingTitle)
  const effectivePrefix = existingTitle ?? namePrefix

  const arms = unionArmsOf(node)
  if (arms) {
    const armNames = nameUnionArms(arms, effectivePrefix)
    arms.forEach(function (arm, index) {
      titleSchemaNode(arm, armNames[index] as string, seenTitles)
    })
    return
  }

  const isEnum = Array.isArray(node['enum'])
  const isObject = node['type'] === 'object' || isSchemaObject(node['properties'])
  const hasConst = node['const'] !== undefined
  if ((isEnum || isObject) && !hasConst && !existingTitle) {
    node['title'] = ensureUniqueTitle(namePrefix, seenTitles)
  }

  const properties = node['properties']
  if (isSchemaObject(properties)) {
    for (const [key, propSchema] of Object.entries(properties)) {
      titleSchemaNode(propSchema, `${effectivePrefix}${toPascalCase(key)}`, seenTitles)
    }
  }
  if (node['items'] !== undefined) {
    titleSchemaNode(node['items'], `${effectivePrefix}Item`, seenTitles)
  }
  if (isSchemaObject(node['additionalProperties'])) {
    titleSchemaNode(node['additionalProperties'], `${effectivePrefix}Value`, seenTitles)
  }
}

/** Entry point for a def's root: the root already has `rootTitle` (assigned
 * by the caller), so only its children need naming — recursing straight into
 * `titleSchemaNode` would treat the root itself as untitled. */
function titleNestedSchemas(root: JsonSchema, rootTitle: string, seenTitles: Set<string>): void {
  const arms = unionArmsOf(root)
  if (arms) {
    const armNames = nameUnionArms(arms, rootTitle)
    arms.forEach(function (arm, index) {
      titleSchemaNode(arm, armNames[index] as string, seenTitles)
    })
    return
  }
  const properties = root['properties']
  if (isSchemaObject(properties)) {
    for (const [key, propSchema] of Object.entries(properties)) {
      titleSchemaNode(propSchema, `${rootTitle}${toPascalCase(key)}`, seenTitles)
    }
  }
  if (root['items'] !== undefined) {
    titleSchemaNode(root['items'], `${rootTitle}Item`, seenTitles)
  }
  if (isSchemaObject(root['additionalProperties'])) {
    titleSchemaNode(root['additionalProperties'], `${rootTitle}Value`, seenTitles)
  }
}

function toWireJsonSchema(schema: z.ZodType, io: 'input' | 'output', defName: string): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any'
  }) as JsonSchema
  delete json['$schema']
  const flattened = flattenAllOfWithUnion(json, defName)
  assertNoRefs(flattened, defName)
  return flattened
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

/**
 * PascalCase class name for a wire type, e.g. `loadModel` -> `LoadModel`,
 * `finetune:progress` -> `FinetuneProgress`. Without a `title`, JSON Schema
 * -> Python codegen (e.g. datamodel-code-generator) falls back to
 * positional names like `Request1Model11` for nested unions — verified
 * empirically against the actual generator, not assumed.
 */
function toPascalCase(name: string): string {
  return name
    .split(/[:\-_]/)
    .map(function (part) {
      return part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part
    })
    .join('')
}

function classTitleFor(name: string, suffix: 'Request' | 'Response'): string {
  return `${toPascalCase(name)}${suffix}`
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
      title: 'AnyRequest',
      description: 'Any request accepted by the server, in wire (pre-parse) shape.',
      anyOf: methodNames.map(function (name) {
        return refTo(`${name}.request`)
      })
    },
    response: {
      title: 'AnyResponse',
      description:
        'Any response emitted by the server, including progress updates and error envelopes.',
      anyOf: responseTypes.map(function (type) {
        return refTo(`${type}.response`)
      })
    }
  }

  const defEntries: Array<[string, z.ZodType, 'input' | 'output', string]> = []
  for (const [type, schema] of requestByType) {
    defEntries.push([`${type}.request`, schema, 'input', classTitleFor(type, 'Request')])
  }
  for (const [type, schema] of responseByType) {
    defEntries.push([`${type}.response`, schema, 'output', classTitleFor(type, 'Response')])
  }
  defEntries.sort(function (a, b) {
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })

  // Seed with every top-level title up front so nested-schema titles (assigned
  // below, per def) can never collide with a top-level def title regardless
  // of iteration order.
  const seenTitles = new Set<string>([
    'AnyRequest',
    'AnyResponse',
    ...defEntries.map((entry) => entry[3])
  ])

  for (const [defName, schema, io, title] of defEntries) {
    const wireSchema = toWireJsonSchema(schema, io, defName)
    titleNestedSchemas(wireSchema, title, seenTitles)
    defs[defName] = { title, ...wireSchema }
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
