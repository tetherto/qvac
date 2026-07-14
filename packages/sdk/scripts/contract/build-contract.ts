import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import prettier from 'prettier'
import { requestSchema, responseSchema } from '@/schemas/common'
import { methodShapes, type MethodName } from '@/server/rpc/method-shapes'
import { constantsRegistry } from '@/schemas/constants-registry'
import { buildModelsRegistry } from './build-models-registry'

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
 * Collapses `oneOf`/`anyOf` arrays that carry exactly one arm into that arm
 * directly, recursively from the leaves up. A single-arm union discriminates
 * nothing, so naming it as a union (wrapper title + arm title) forces the
 * arm into a name distinct from a wrapper it's identical to — e.g.
 * `reloadConfigRequestSchema = z.union([reloadConfigWhisperRequestSchema])`
 * produced both a `ReloadConfigRequest` (the wrapper) and a
 * `ReloadConfigRequest2` (the lone arm) for what is really one type.
 * Collapsing first means there's only ever one node here for titling to see.
 * The wrapper's own explicit `title` (its `.meta()`), if any, wins over the
 * arm's — it's the intentional public name for the schema export.
 */
function collapseSingleMemberUnions(node: unknown): unknown {
  if (!isSchemaObject(node)) return node

  const properties = node['properties']
  if (isSchemaObject(properties)) {
    for (const key of Object.keys(properties)) {
      properties[key] = collapseSingleMemberUnions(properties[key])
    }
  }
  if (node['items'] !== undefined) {
    node['items'] = collapseSingleMemberUnions(node['items'])
  }
  if (isSchemaObject(node['additionalProperties'])) {
    node['additionalProperties'] = collapseSingleMemberUnions(node['additionalProperties'])
  }

  const unionKey = Array.isArray(node['oneOf'])
    ? 'oneOf'
    : Array.isArray(node['anyOf'])
      ? 'anyOf'
      : undefined
  if (!unionKey) return node

  const arms = (node[unionKey] as unknown[]).map(collapseSingleMemberUnions)
  if (arms.length !== 1) {
    node[unionKey] = arms
    return node
  }

  const arm = arms[0]
  const wrapperTitle = typeof node['title'] === 'string' ? node['title'] : undefined
  const wrapperRest: JsonSchema = { ...node }
  delete wrapperRest[unionKey]
  if (!isSchemaObject(arm)) return wrapperTitle ? wrapperRest : arm

  const merged: JsonSchema = { ...wrapperRest, ...arm }
  if (wrapperTitle) merged['title'] = wrapperTitle
  return merged
}

function constValueOf(arm: JsonSchema, key: string): string | undefined {
  const properties = arm['properties']
  const field = isSchemaObject(properties) ? properties[key] : undefined
  return isSchemaObject(field) && typeof field['const'] === 'string' ? field['const'] : undefined
}

/**
 * Property key that best discriminates a set of sibling union arms: the
 * `const` string field, wherever present, that splits the arms into the most
 * distinct groups — counting "arms with no const for this key at all" as one
 * more group (they'll be disambiguated some other way; see `nameUnionArms`).
 * Picks the *best* key rather than requiring perfection — two shortcomings
 * otherwise cause bad names:
 *
 * - Requiring every arm to carry the key: `loadModel`'s custom-plugin
 *   catch-all arm has no `modelType` const, so demanding full coverage threw
 *   away `modelType` for the other 11 arms too.
 * - Requiring the value to never repeat: `completionStream`'s event union
 *   has two arms both typed `completionDone` (success vs. error) — demanding
 *   perfect uniqueness rejected `type` for all 8 events, even though it
 *   cleanly separates the other 6. `nameUnionArms` recurses into the
 *   colliding pair to find a secondary key (`stopReason`) instead.
 *
 * Also deliberately not a fixed guess-list of names (`type`/`operation`/...):
 * the wire method discriminator (`type`) is IDENTICAL across every arm of a
 * single method's own operation union (e.g. every `rag` arm has
 * `type: 'rag'`), so guessing by name picked the one field that never
 * discriminates anything and produced `RagRequestRag`, `RagRequestRag2`, ...
 * A key where every arm lands in one single group is rejected outright —
 * it's exactly this "same value everywhere" (or "no arm has it") case.
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
  let bestGroupCount = 1 // a key producing only 1 group discriminates nothing
  for (const key of candidateKeys) {
    const values = new Set<string>()
    let anyMissing = false
    for (const arm of arms) {
      const value = constValueOf(arm, key)
      if (value === undefined) anyMissing = true
      else values.add(value)
    }
    const groupCount = values.size + (anyMissing ? 1 : 0)
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

/** Whether a schema node is itself substantial enough to need a title: an
 * object, an enum, or a nested union (whose own arms will need names) —
 * as opposed to a bare scalar (`{type: 'string'}`) or `{}` ("any"), which
 * never get titled regardless of position. */
function needsOwnTitle(node: unknown): boolean {
  if (!isSchemaObject(node)) return false
  if (unionArmsOf(node)) return true
  const isEnum = Array.isArray(node['enum'])
  const isObject = node['type'] === 'object' || isSchemaObject(node['properties'])
  const hasConst = node['const'] !== undefined
  return (isEnum || isObject) && !hasConst
}

/**
 * Names each arm of a union: by the shared discriminator's value when the
 * arms have one in common; else, if at most one arm actually needs a title
 * (e.g. `string | { repeats: number }` — only the object arm does), that one
 * arm gets the bare prefix with no suffix, since there's nothing to
 * disambiguate; only when neither applies does it fall back to positional
 * naming (1-based: `Foo1`, `Foo2`, ...).
 */
function nameUnionArms(arms: JsonSchema[], namePrefix: string): string[] {
  if (arms.length <= 1) {
    return arms.map(function () {
      return namePrefix
    })
  }

  const key = pickDiscriminatorKey(arms)
  if (!key) {
    if (arms.filter(needsOwnTitle).length <= 1) {
      return arms.map(function () {
        return namePrefix
      })
    }
    return arms.map(function (_arm, index) {
      return `${namePrefix}${index + 1}`
    })
  }

  // Group arms by their value for `key` (arms with no const for `key` share
  // the `undefined` group). A key is only ever picked when it produces more
  // than one group (see pickDiscriminatorKey), so every group here is
  // strictly smaller than `arms` — groups with more than one member recurse
  // to find a secondary discriminator instead of falling straight to
  // `ensureUniqueTitle`'s numeric bump. This is what turns two arms sharing
  // `type: 'completionDone'` into `...CompletionDoneError` (has a `stopReason`
  // const) and bare `...CompletionDone` (the lone arm left without one)
  // instead of `...CompletionDone` / `...CompletionDone2`.
  const groupOrder: Array<string | undefined> = []
  const groups = new Map<string | undefined, number[]>()
  arms.forEach(function (arm, index) {
    const value = constValueOf(arm, key)
    if (!groups.has(value)) {
      groupOrder.push(value)
      groups.set(value, [])
    }
    groups.get(value)?.push(index)
  })

  const names = new Array<string>(arms.length)
  for (const value of groupOrder) {
    const indexes = groups.get(value) as number[]
    const groupPrefix = value !== undefined ? `${namePrefix}${toPascalCase(value)}` : namePrefix
    if (indexes.length === 1) {
      names[indexes[0] as number] = groupPrefix
      continue
    }
    const subNames = nameUnionArms(
      indexes.map(function (index) {
        return arms[index] as JsonSchema
      }),
      groupPrefix
    )
    indexes.forEach(function (armIndex, i) {
      names[armIndex] = subNames[i] as string
    })
  }
  return names
}

/**
 * Assigns a `title` to `node` (unless it already has one) and recurses into
 * its properties/items/union arms, naming each by its property key or (for
 * discriminated union arms) the arm's discriminator value — e.g.
 * `completionStream.response`'s event union gets
 * `CompletionStreamResponseEventsItemContentDelta` instead of a bare `Events3`.
 *
 * Without this, nested/inline Zod schemas reach codegen (verified against
 * datamodel-code-generator, a JSON-Schema-to-pydantic tool) as
 * positionally-numbered classes (`Stats13`, `Events7`) with no indication of
 * what they represent.
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

  const arms = unionArmsOf(node)
  if (arms) {
    const effectivePrefix = existingTitle ?? namePrefix
    const armNames = nameUnionArms(arms, effectivePrefix)
    arms.forEach(function (arm, index) {
      titleSchemaNode(arm, armNames[index] as string, seenTitles)
    })
    return
  }

  // If namePrefix collided with an already-assigned title, ensureUniqueTitle
  // bumps it (e.g. `...CompletionDone` -> `...CompletionDone2`). Children
  // must be prefixed with that *final* title, not the pre-bump namePrefix —
  // otherwise a child two levels down silently collides with an unrelated
  // sibling's identically-(pre-bump-)named child instead of its own.
  const assignedTitle =
    needsOwnTitle(node) && !existingTitle ? ensureUniqueTitle(namePrefix, seenTitles) : undefined
  if (assignedTitle) node['title'] = assignedTitle
  const effectivePrefix = existingTitle ?? assignedTitle ?? namePrefix

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
  const collapsed = collapseSingleMemberUnions(flattened) as JsonSchema
  assertNoRefs(collapsed, defName)
  return collapsed
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
 * -> codegen (e.g. datamodel-code-generator) falls back to positional names
 * like `Request1Model11` for nested unions — verified empirically against
 * the actual generator, not assumed.
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

/**
 * The 4 methods that can switch from a plain unary reply to a stream of
 * responses when the caller opts in (`request.withProgress === true`):
 * progress events and the final reply both arrive as stream frames,
 * distinguished only by each payload's own `type` — see
 * `server/rpc/handler-selection.ts` (`handlerSupportsProgress`) and
 * `server/rpc/handler-registry.ts` for the source of truth this mirrors.
 *
 * `rag` and `finetune` gate progress further on the request's `operation`
 * (see `ragSupportsProgress`/`finetuneSupportsProgress` in
 * `handler-registry.ts`) — `condition` spells out that extra check so a
 * contract consumer doesn't have to special-case it separately.
 */
const progressByMethod: Partial<Record<MethodName, { condition: string; responseType: string }>> = {
  loadModel: { condition: 'request.withProgress === true', responseType: 'modelProgress' },
  downloadAsset: { condition: 'request.withProgress === true', responseType: 'modelProgress' },
  rag: {
    condition:
      "request.withProgress === true && ['ingest', 'saveEmbeddings', 'reindex'].includes(request.operation)",
    responseType: 'rag:progress'
  },
  finetune: {
    condition:
      "request.withProgress === true && ['start', 'resume', undefined].includes(request.operation)",
    responseType: 'finetune:progress'
  }
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

  for (const [methodName, progress] of Object.entries(progressByMethod)) {
    if (!responseByType.has(progress.responseType)) {
      throw new Error(
        `progressByMethod["${methodName}"] points at response type "${progress.responseType}", ` +
          'which has no schema in the response union'
      )
    }
  }

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

  // Public constants (@/schemas/constants-registry), merged into the same
  // $defs as every request/response type via the same z.toJSONSchema call —
  // not a separate artifact. `x-enum-varnames` preserves each entry's
  // original key names (`ModelType.llamacppCompletion`, `PluginId.LLM`, ...)
  // through codegen; plain JSON Schema `enum:` only carries values.
  const constantVarNames = new Map<string, readonly string[]>()
  for (const [name, schema] of Object.entries(constantsRegistry)) {
    const defName = `constants.${name}`
    defEntries.push([defName, schema, 'output', name])
    constantVarNames.set(defName, Object.keys(schema.enum))
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
    const varNames = constantVarNames.get(defName)
    defs[defName] = {
      title,
      ...wireSchema,
      ...(varNames && { 'x-enum-varnames': varNames })
    }
  }

  const manifest = {
    methods: methodNames.map(function (name) {
      const progress = progressByMethod[name]
      return {
        name,
        callShape: callShapeByHandlerType[methodShapes[name]],
        requestSchema: `schema.json#/$defs/${name}.request`,
        responseSchema: `schema.json#/$defs/${name}.response`,
        ...(progress && {
          progress: {
            condition: progress.condition,
            responseSchema: `schema.json#/$defs/${progress.responseType}.response`
          }
        })
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
  const modelsRegistry = buildModelsRegistry()
  return {
    'schema.json': await formatJson(schemaDocument, 'schema.json'),
    'manifest.json': await formatJson(manifest, 'manifest.json'),
    'models.json': await formatJson(modelsRegistry, 'models.json')
  }
}
