import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'

export type ParserResult = {
  matched: boolean
  toolCalls: ToolCall[]
  errors: ToolCallError[]
}

// A parameter's candidate types in declaration order, `null` excluded. Type
// arrays and `anyOf`/`oneOf` branches are flattened; a branch with only `enum`
// contributes the types of its values.
export function parameterTypes(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return []
  const {
    type,
    anyOf,
    oneOf,
    enum: enumValues
  } = schema as {
    type?: unknown
    anyOf?: unknown
    oneOf?: unknown
    enum?: unknown
  }
  let types: unknown[] = []
  if (typeof type === 'string') types = [type]
  else if (Array.isArray(type)) types = type
  else if (Array.isArray(anyOf) || Array.isArray(oneOf)) {
    types = ((Array.isArray(anyOf) ? anyOf : oneOf) as unknown[]).flatMap(parameterTypes)
  } else if (Array.isArray(enumValues)) {
    types = enumValues.map((v) => (v === null ? 'null' : typeof v))
  }
  const names = types.filter((t): t is string => typeof t === 'string' && t !== 'null')
  return [...new Set(names)]
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

// Coerces raw parameter text against a union by trying each candidate type in
// declaration order with `string` last, keeping the first that succeeds. A
// single-type parameter keeps the parser's own coercion and error.
export function coerceByParameterTypes(
  raw: string,
  types: string[],
  coerce: (raw: string, type: string) => unknown
): unknown {
  if (types.length === 0) return raw
  if (types.length === 1) return coerce(raw, types[0]!)
  const ordered = [...types.filter((t) => t !== 'string'), ...types.filter((t) => t === 'string')]
  let firstError: unknown
  for (const type of ordered) {
    try {
      const value = coerce(raw, type)
      if (matchesType(value, type)) return value
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError ?? new Error(`value does not match any of: ${types.join(', ')}`)
}

export function parameterAllowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false
  const { type, anyOf, oneOf } = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown }
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true
  const branches = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : []
  return branches.some(parameterAllowsNull)
}

export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '')
}

let toolCallSequence = 0

export function generateStableToolCallId(name: string, args: Record<string, unknown>) {
  const content = `${name}:${JSON.stringify(args)}`
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  const sequence = toolCallSequence++
  return `call_${Math.abs(hash).toString(36)}_${sequence}`
}

export function isValidToolCall(obj: unknown): obj is {
  name: string
  arguments: Record<string, unknown>
  id?: string
} {
  if (!obj || typeof obj !== 'object') {
    return false
  }
  if (!('name' in obj) || typeof obj.name !== 'string') {
    return false
  }
  if (!('arguments' in obj) || typeof obj.arguments !== 'object' || obj.arguments === null) {
    return false
  }
  return true
}

export function validateToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  tools: Tool[]
): { isValid: boolean; error?: ToolCallError } {
  const tool = tools.find((t) => t.name === toolName)

  if (!tool) {
    return {
      isValid: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Tool "${toolName}" not found in available tools`
      }
    }
  }

  const required = tool.parameters.required || []
  for (const requiredParam of required) {
    if (!(requiredParam in args)) {
      return {
        isValid: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Missing required parameter "${requiredParam}" for tool "${toolName}"`
        }
      }
    }
  }

  return { isValid: true }
}
