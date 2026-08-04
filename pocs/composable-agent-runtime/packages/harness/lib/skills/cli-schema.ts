import path from '#path'
import { parseToolGrant } from './tool-grants.ts'

export interface JsonSchema {
  readonly type?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly pattern?: string
  readonly enum?: readonly unknown[]
  readonly 'x-positionals'?: readonly string[]
  readonly 'x-rest'?: string
}

export interface CliValidator {
  readonly bin: string
  readonly check: (argv: readonly string[]) => string | null
}

export function buildCliValidatorFromBundle(
  skillName: string,
  tools: readonly string[],
  files: Readonly<Record<string, string>>
): CliValidator | undefined {
  const grant = tools.map((entry) => parseToolGrant(entry)).find((entry) => entry.name === 'exec')
  if (!grant || !grant.scope) return undefined
  const key = `${skillName}/cli.schema.json`
  const rawSchema = files[key]
  if (!rawSchema) return undefined

  let schema: JsonSchema
  try {
    const parsed: unknown = JSON.parse(rawSchema)
    if (!isObject(parsed)) return { bin: grant.scope, check: () => 'skill cli schema is invalid' }
    schema = parsed as JsonSchema
  } catch {
    return { bin: grant.scope, check: () => 'skill cli schema is invalid' }
  }

  return {
    bin: grant.scope,
    check: (argv) => checkAgainstSchema(argv, schema)
  }
}

function checkAgainstSchema(argv: readonly string[], schema: JsonSchema): string | null {
  const object = argvToObject(argv, schema)
  if (typeof object === 'string') return object
  const pathError = validatePathArguments(object)
  if (pathError) return pathError
  const schemaError = validateObject(object, schema)
  if (schemaError) return schemaError
  return null
}

function argvToObject(argv: readonly string[], schema: JsonSchema): Record<string, unknown> | string {
  let node = schema
  const commands: string[] = []
  let index = 0
  while (index < argv.length) {
    const token = argv[index] ?? ''
    if (isParamToken(token)) break
    const next = node.properties?.[token]
    if (!next || !isObjectSchema(next)) break
    commands.push(token)
    node = next
    index++
  }
  const leaf = parseParams(argv.slice(index), node)
  if (typeof leaf === 'string') return leaf
  let output = leaf
  for (let i = commands.length - 1; i >= 0; i--) output = { [commands[i] as string]: output }
  return output
}

function parseParams(tokens: readonly string[], schema: JsonSchema): Record<string, unknown> | string {
  const properties = schema.properties ?? {}
  const keys = new Set(Object.keys(properties))
  const booleans = new Set(
    Object.entries(properties)
      .filter(([, value]) => value.type === 'boolean')
      .map(([key]) => key)
  )
  const positionals = schema['x-positionals'] ?? []
  const restKey = schema['x-rest']
  const output: Record<string, unknown> = {}
  const rest: string[] = []
  let positionalIndex = 0
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    const canAbsorb = positionalIndex < positionals.length || restKey !== undefined
    const eq = token.indexOf('=')
    if (eq > 0 && !token.startsWith('-')) {
      const key = token.slice(0, eq)
      if (keys.has(key)) {
        output[key] = token.slice(eq + 1)
        index++
        continue
      }
      if (!canAbsorb) return `unknown parameter "${key}"`
    }

    if (token.startsWith('-')) {
      const key = token.replace(/^-+/, '')
      if (keys.has(key)) {
        if (booleans.has(key)) {
          output[key] = true
          index++
          continue
        }
        const next = tokens[index + 1]
        if (next === undefined || next.startsWith('-')) {
          return `flag --${key} requires a value`
        }
        output[key] = next
        index += 2
        continue
      }
      if (!canAbsorb) return `unknown flag "--${key}"`
    }

    if (booleans.has(token)) {
      output[token] = true
      index++
      continue
    }

    if (positionalIndex < positionals.length) {
      const key = positionals[positionalIndex]
      if (!key) return 'invalid positional schema'
      output[key] = token
      positionalIndex++
      index++
      continue
    }

    if (restKey) {
      rest.push(token)
      index++
      continue
    }
    return `unexpected argument "${token}"`
  }
  if (restKey && rest.length > 0) output[restKey] = rest
  return output
}

function validateObject(value: unknown, schema: JsonSchema, location = ''): string | null {
  if (schema.type === 'string') return validateString(value, schema, location)
  if (schema.type === 'boolean') return typeof value === 'boolean' ? null : `${location} must be boolean`
  if (schema.type === 'array') return Array.isArray(value) ? null : `${location} must be array`

  if (!isObjectSchema(schema)) return null
  if (!isObject(value)) return location ? `${location} must be object` : 'command must be object'
  const properties = schema.properties ?? {}
  const required = schema.required ?? []
  for (const key of required) {
    if (!(key in value)) return key
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) return `unknown property "${key}"`
    }
  }
  for (const [key, property] of Object.entries(properties)) {
    if (!(key in value)) continue
    const child = validateObject(
      (value as Record<string, unknown>)[key],
      property,
      location ? `${location}.${key}` : key
    )
    if (child) return child
  }
  return null
}

function validateString(value: unknown, schema: JsonSchema, location: string): string | null {
  if (typeof value !== 'string') return `${location} must be string`
  if (schema.pattern) {
    const pattern = new RegExp(schema.pattern)
    if (!pattern.test(value)) return `${location} does not match required pattern`
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${location} must be one of ${schema.enum.join(', ')}`
  }
  return null
}

function validatePathArguments(value: unknown): string | null {
  if (typeof value === 'string') return validateRelativePath(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const error = validatePathArguments(entry)
      if (error) return error
    }
    return null
  }
  if (!isObject(value)) return null
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === 'path' ||
      key === 'file' ||
      key === 'folder' ||
      key === 'name'
    ) {
      if (typeof entry !== 'string') return 'path must be string'
      const error = validateRelativePath(entry)
      if (error) return error
    }
    const nested = validatePathArguments(entry)
    if (nested) return nested
  }
  return null
}

function validateRelativePath(value: string): string | null {
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~')) {
    return 'path must be vault-relative, absolute paths are forbidden'
  }
  const parts = value.split(/[\\/]+/)
  if (parts.some((part) => part === '..')) {
    return 'path traversal is forbidden'
  }
  return null
}

function isParamToken(token: string): boolean {
  return token.startsWith('-') || token.includes('=')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === 'object' || (!schema.type && typeof schema.properties === 'object')
}
