/**
 * Reads the SDK contract's JSON Schema into one model every renderer shares:
 * the HTML field tables and the Markdown cards draw the same facts from it.
 *
 * The contract uses a small, closed part of JSON Schema: objects with
 * properties, literal enums and consts, arrays, records, `$ref`s into
 * `$defs`, and `oneOf`/`anyOf` unions whose object arms carry a title. That is
 * all this module reads. A construct outside it is shown as its own type
 * label rather than expanded, never guessed at.
 */

export interface JsonSchema {
  $ref?: string
  title?: string
  description?: string
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  prefixItems?: JsonSchema[]
  enum?: unknown[]
  const?: unknown
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  propertyNames?: JsonSchema
  default?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  format?: string
  not?: JsonSchema
  [key: string]: unknown
}

export interface Field {
  name: string
  required: boolean
  type: string
  description?: string
  default?: string
  constraints: string[]
  /** Literal values accepted, when the field is an enum or a union of literals. */
  values?: string[]
  /** The field's own fields, when it is an object or a union of objects. */
  shape?: Shape
}

export type Shape =
  | { kind: 'object'; fields: Field[] }
  | { kind: 'variants'; variants: Variant[] }

export interface Variant {
  label: string
  shape: Extract<Shape, { kind: 'object' }>
}

const MAX_DEPTH = 8

export class SchemaReader {
  constructor(private readonly root: { $defs?: Record<string, JsonSchema> }) {}

  definition(name: string): JsonSchema | null {
    return this.root.$defs?.[name] ?? null
  }

  resolve(schema: JsonSchema, seen: ReadonlySet<string> = new Set()): JsonSchema {
    let current = schema
    const visited = new Set(seen)
    while (current.$ref) {
      const name = decodeURIComponent(current.$ref.replace(/^#\/\$defs\//, ''))
      if (visited.has(name)) break
      visited.add(name)
      const target = this.definition(name)
      if (!target) break
      const { $ref: _ref, ...rest } = current
      current = { ...target, ...rest }
    }
    return current
  }

  /** The object or union-of-objects shape of a schema, or null for a scalar. */
  shapeOf(schema: JsonSchema, hidden: ReadonlySet<string> = new Set(), depth = 0): Shape | null {
    if (depth > MAX_DEPTH) return null
    const resolved = this.resolve(schema)
    const arms = (resolved.oneOf ?? resolved.anyOf)?.map((arm) => this.resolve(arm))
    if (arms && arms.length > 1 && arms.every((arm) => this.isObject(arm))) {
      return {
        kind: 'variants',
        variants: arms.map((arm, index) => ({
          label: variantLabel(arm, index),
          shape: this.objectShape(arm, hidden, depth),
        })),
      }
    }
    if (arms && arms.length === 1 && this.isObject(arms[0])) return this.objectShape(arms[0], hidden, depth)
    if (this.isObject(resolved)) return this.objectShape(resolved, hidden, depth)
    return null
  }

  private isObject(schema: JsonSchema): boolean {
    return Boolean(schema.properties) && (schema.type === undefined || schema.type === 'object')
  }

  private objectShape(
    schema: JsonSchema,
    hidden: ReadonlySet<string>,
    depth: number,
  ): Extract<Shape, { kind: 'object' }> {
    const required = new Set(schema.required ?? [])
    const fields = Object.entries(schema.properties ?? {})
      .filter(([name]) => !hidden.has(name))
      .map(([name, property]) => this.field(name, property, required.has(name), depth))
    return { kind: 'object', fields }
  }

  private field(name: string, property: JsonSchema, required: boolean, depth: number): Field {
    const resolved = this.resolve(property)
    const shape = this.shapeOf(resolved, new Set(), depth + 1) ?? this.shapeOf(this.elementOf(resolved) ?? {}, new Set(), depth + 1)
    return {
      name,
      required,
      type: this.typeLabel(resolved),
      description: resolved.description ?? property.description,
      default: resolved.default === undefined ? undefined : JSON.stringify(resolved.default),
      constraints: constraintsOf(resolved),
      values: this.literalValues(resolved),
      shape: shape ?? undefined,
    }
  }

  /** The element schema of an array, or of an array inside a union. */
  private elementOf(schema: JsonSchema): JsonSchema | null {
    if (schema.items) return this.resolve(schema.items)
    for (const arm of schema.anyOf ?? schema.oneOf ?? []) {
      const resolved = this.resolve(arm)
      if (resolved.items) return this.resolve(resolved.items)
    }
    return null
  }

  private literalValues(schema: JsonSchema): string[] | undefined {
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value))
    const arms = schema.anyOf ?? schema.oneOf
    if (!arms) return undefined
    const literals = arms.map((arm) => this.resolve(arm)).filter((arm) => arm.const !== undefined || arm.enum)
    if (literals.length === 0) return undefined
    return literals.flatMap((arm) => (arm.enum ?? [arm.const]).map((value) => JSON.stringify(value)))
  }

  /** A TypeScript-style label for a schema's type. */
  typeLabel(schema: JsonSchema, depth = 0): string {
    if (depth > MAX_DEPTH) return 'unknown'
    const resolved = this.resolve(schema)
    if (resolved.const !== undefined) return JSON.stringify(resolved.const)
    if (resolved.enum) return resolved.enum.map((value) => JSON.stringify(value)).join(' | ')
    const arms = resolved.oneOf ?? resolved.anyOf
    if (arms) {
      const labels = [...new Set(arms.map((arm) => this.typeLabel(arm, depth + 1)))]
      return labels.join(' | ')
    }
    const type = resolved.type
    if (Array.isArray(type)) return type.map((entry) => primitive(entry)).join(' | ')
    if (type === 'array' || resolved.items || resolved.prefixItems) {
      if (resolved.prefixItems) {
        return `[${resolved.prefixItems.map((item) => this.typeLabel(item, depth + 1)).join(', ')}]`
      }
      const element = this.typeLabel(resolved.items ?? {}, depth + 1)
      return element.includes(' | ') ? `(${element})[]` : `${element}[]`
    }
    if (type === 'object' || resolved.properties || resolved.additionalProperties !== undefined) {
      if (resolved.properties) return resolved.title ?? 'object'
      if (typeof resolved.additionalProperties === 'object') {
        return `Record<string, ${this.typeLabel(resolved.additionalProperties, depth + 1)}>`
      }
      return 'Record<string, unknown>'
    }
    if (typeof type === 'string') return primitive(type)
    return 'unknown'
  }
}

function primitive(type: string): string {
  if (type === 'integer') return 'number'
  return type
}

function variantLabel(arm: JsonSchema, index: number): string {
  if (arm.title) return arm.title
  const discriminator = Object.entries(arm.properties ?? {}).find(([, property]) => property.const !== undefined)
  return discriminator ? `${discriminator[0]}: ${JSON.stringify(discriminator[1].const)}` : `Variant ${index + 1}`
}

function constraintsOf(schema: JsonSchema): string[] {
  const constraints: string[] = []
  if (schema.minimum !== undefined) constraints.push(`≥ ${schema.minimum}`)
  if (schema.exclusiveMinimum !== undefined) constraints.push(`> ${schema.exclusiveMinimum}`)
  if (schema.maximum !== undefined) constraints.push(`≤ ${schema.maximum}`)
  if (schema.minLength !== undefined) constraints.push(`min length ${schema.minLength}`)
  if (schema.maxLength !== undefined) constraints.push(`max length ${schema.maxLength}`)
  if (schema.minItems !== undefined) constraints.push(`min items ${schema.minItems}`)
  if (schema.maxItems !== undefined) constraints.push(`max items ${schema.maxItems}`)
  if (schema.pattern !== undefined) constraints.push(`pattern \`${schema.pattern}\``)
  if (schema.format !== undefined) constraints.push(`format ${schema.format}`)
  return constraints
}
