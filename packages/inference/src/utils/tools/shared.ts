import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'

export type ParserResult = {
  matched: boolean
  toolCalls: ToolCall[]
  errors: ToolCallError[]
}

// The one type a parameter value is coerced to: a nullable `["string", "null"]`
// or `anyOf` union resolves to its first non-null member.
export function primaryParameterType(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const { type, anyOf, oneOf } = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown }
  if (typeof type === 'string') return type === 'null' ? undefined : type
  if (Array.isArray(type)) {
    return type.find((t): t is string => typeof t === 'string' && t !== 'null')
  }
  const branches = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : []
  for (const branch of branches) {
    const resolved = primaryParameterType(branch)
    if (resolved !== undefined) return resolved
  }
  return undefined
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
