import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'
import {
  acceptToolCall,
  coerceByParameterTypes,
  parameterAllowsNull,
  parameterTypes,
  type ParserResult
} from '@/utils/tools/shared'
import { omittable, readStructured } from '@/utils/tools/repair'

// Coerce raw parameter text to the type declared in the tool's JSON schema.
// String values are raw (not JSON-quoted); arrays/objects are valid JSON.
function coerceParamValue(raw: string, schema?: unknown): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'null' && parameterAllowsNull(schema)) return null
  const types = parameterTypes(schema)
  // Malformed JSON is repaired only where a string could not have been meant.
  const lenient = !types.includes('string')
  return coerceByParameterTypes(trimmed, types, (raw, type) => coerceToType(raw, type, lenient))
}

function coerceToType(trimmed: string, type: string, lenient: boolean): unknown {
  switch (type) {
    case 'number': {
      if (trimmed.length === 0) throw new Error(`invalid numeric value: ""`)
      const n = Number(trimmed)
      if (Number.isNaN(n)) throw new Error(`invalid numeric value: "${trimmed}"`)
      return n
    }
    case 'integer': {
      if (trimmed.length === 0) throw new Error(`invalid integer value: ""`)
      const n = Number(trimmed)
      if (Number.isNaN(n) || !Number.isInteger(n)) {
        throw new Error(`invalid integer value: "${trimmed}"`)
      }
      return n
    }
    case 'boolean': {
      // Qwen3.5/3.6/3.8 intermittently emit Python-style capitalised booleans
      // (`True`/`False`); accept any casing so a valid call isn't dropped.
      const v = trimmed.toLowerCase()
      if (v === 'true') return true
      if (v === 'false') return false
      throw new Error(`invalid boolean value: "${trimmed}"`)
    }
    case 'array':
    case 'object': {
      if (!lenient) return JSON.parse(trimmed)
      const value = readStructured(trimmed, new Set([type]))
      if (value === null) throw new Error(`invalid ${type} value`)
      return value
    }
    default:
      return trimmed
  }
}

// Parses Qwen3.5/3.6/3.8 Pythonic-XML tool-call format:
//   <tool_call>
//   <function=NAME>
//   <parameter=KEY>VALUE</parameter>
//   </function>
//   </tool_call>
// String parameter values are raw text (not JSON-quoted); arrays/objects
// are JSON. Type coercion uses the tool schema; unknown params pass through.
export function parseQwen35Format(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  if (!text.includes('<tool_call>')) return { matched: false, toolCalls, errors }

  const outerRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  const outerMatches = Array.from(text.matchAll(outerRegex))

  if (outerMatches.length === 0) return { matched: false, toolCalls, errors }

  // If no match contains XML function syntax, check if this is JSON format
  // (defer to hermes) or just malformed content (surface as PARSE_ERROR).
  if (!outerMatches.some((m) => m[1]!.includes('<function='))) {
    const looksLikeJson = outerMatches.some((m) => {
      const inner = m[1]!.trim()
      return inner.startsWith('{') || inner.startsWith('[')
    })
    if (looksLikeJson) return { matched: false, toolCalls, errors }
    return {
      matched: true,
      toolCalls,
      errors: outerMatches.map((m) => ({
        code: 'PARSE_ERROR' as const,
        message: 'Qwen3.5 tool call missing <function=NAME>...</function>',
        raw: m[1]!.trim()
      }))
    }
  }

  for (const outerMatch of outerMatches) {
    const inner = outerMatch[1]!.trim()

    const fnMatch = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/i.exec(inner)
    if (!fnMatch) {
      errors.push({
        code: 'PARSE_ERROR',
        message: 'Qwen3.5 tool call missing <function=NAME>...</function>',
        raw: inner
      })
      continue
    }

    const result = decodeFunctionCall(fnMatch[1]!.trim(), fnMatch[2]!, tools, inner)
    if (result.error) errors.push(result.error)
    else toolCalls.push(result.call)
  }

  return { matched: true, toolCalls, errors }
}

const PARAM_REGEX = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi

function decodeFunctionCall(
  name: string,
  paramsBlock: string,
  tools: Tool[],
  raw: string
): { call: ToolCall; error?: undefined } | { call?: undefined; error: ToolCallError } {
  const parameters = tools.find((t) => t.name === name)?.parameters
  const schemaProperties = parameters?.properties ?? {}
  const required = parameters?.required ?? []
  const args: Record<string, unknown> = {}
  // A parameter that never closes would otherwise vanish and leave its default.
  if (/<parameter=/i.test(paramsBlock.replace(PARAM_REGEX, ''))) {
    return { error: { code: 'PARSE_ERROR', message: 'Unclosed <parameter> in tool call', raw } }
  }
  try {
    for (const pm of paramsBlock.matchAll(PARAM_REGEX)) {
      const paramName = pm[1]!.trim()
      const schema = schemaProperties[paramName]
      if (pm[2]!.trim() === 'null' && !required.includes(paramName) && omittable(schema)) continue
      args[paramName] = coerceParamValue(pm[2]!, schema)
    }
  } catch (err) {
    return {
      error: { code: 'PARSE_ERROR', message: err instanceof Error ? err.message : String(err), raw }
    }
  }
  return acceptToolCall({ name, arguments: args }, tools, raw)
}

/**
 * Opener of a bare `<function=NAME>` block, which Qwen-family models emit
 * without the `<tool_call>` wrapper. The streaming normalizer and this parser
 * share it, so markup is hidden exactly when it is recovered.
 */
export const BARE_FUNCTION_OPEN = '<function='
export const BARE_FUNCTION_CLOSE = '</function>'
const MAX_FUNCTION_NAME_LENGTH = 64
const NAME = `[A-Za-z_][\\w.-]{0,${MAX_FUNCTION_NAME_LENGTH - 1}}`
const BARE_FUNCTION_NAME = new RegExp(`^${NAME}\\s*>`)
const BARE_FUNCTION_NAME_PREFIX = new RegExp(`^${NAME}\\s*$|^$`)
// Longest `NAME>` worth waiting for: the name, a few spaces and `>`.
const BARE_NAME_WINDOW = MAX_FUNCTION_NAME_LENGTH + 6
// What a call body starts with; anything else after `NAME>` is prose. A nested
// opener is held too, so the wrapper is rejected as ambiguous, not streamed.
const BARE_BODY_OPENERS = ['<parameter=', BARE_FUNCTION_CLOSE, BARE_FUNCTION_OPEN]
const BARE_BODY_OPENER_LENGTH = Math.max(...BARE_BODY_OPENERS.map((opener) => opener.length))
// Whitespace a template puts between `NAME>` and the body; more than this is prose.
const MAX_BODY_GAP = 64

/**
 * Length of the `NAME>` that follows a bare `<function=` opener in `rest`;
 * 0 while it may still arrive, -1 when `rest` cannot start one.
 */
export function bareFunctionNameLength(rest: string): number {
  const match = BARE_FUNCTION_NAME.exec(rest)
  if (match) return match[0].length
  return BARE_FUNCTION_NAME_PREFIX.test(rest.slice(0, BARE_NAME_WINDOW)) &&
    rest.length < BARE_NAME_WINDOW
    ? 0
    : -1
}

/**
 * Whether the text after a bare block's `NAME>` starts a call body: 1 when it
 * does, 0 while it may still, -1 when it is prose.
 */
export function bareFunctionBodyStart(body: string): number {
  // Bounded, so a run of whitespace is neither held nor rescanned without end.
  const head = body.slice(0, MAX_BODY_GAP + BARE_BODY_OPENER_LENGTH)
  const start = head.trimStart()
  if (head.length - start.length > MAX_BODY_GAP) return -1
  if (BARE_BODY_OPENERS.some((opener) => start.startsWith(opener))) return 1
  return BARE_BODY_OPENERS.some((opener) => opener.startsWith(start)) ? 0 : -1
}

// A `<function=` left outside the parameter values means one call wraps another.
function hasNestedOpener(body: string): boolean {
  return body.replace(PARAM_REGEX, '').includes(BARE_FUNCTION_OPEN)
}

// Bare `<function=NAME>...</function>` blocks naming a declared tool. A block
// naming no declared tool, or wrapping another opener, is text, not a call.
export function parseBareFunctionFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []
  let matched = false
  let cursor = 0
  for (;;) {
    const start = text.indexOf(BARE_FUNCTION_OPEN, cursor)
    if (start === -1) break
    const nameStart = start + BARE_FUNCTION_OPEN.length
    const nameLength = bareFunctionNameLength(text.slice(nameStart, nameStart + BARE_NAME_WINDOW))
    if (nameLength <= 0) {
      cursor = nameStart
      continue
    }
    const bodyStart = nameStart + nameLength
    const close = text.indexOf(BARE_FUNCTION_CLOSE, bodyStart)
    if (close === -1) break
    const end = close + BARE_FUNCTION_CLOSE.length
    cursor = end
    const name = text.slice(nameStart, bodyStart - 1).trim()
    const body = text.slice(bodyStart, close)
    if (!tools.some((t) => t.name === name)) continue
    if (bareFunctionBodyStart(body + BARE_FUNCTION_CLOSE) < 1 || hasNestedOpener(body)) continue
    matched = true
    const raw = text.slice(start, end)
    const result = decodeFunctionCall(name, body, tools, raw)
    if (result.error) errors.push(result.error)
    else toolCalls.push(result.call)
  }
  return { matched, toolCalls, errors }
}
