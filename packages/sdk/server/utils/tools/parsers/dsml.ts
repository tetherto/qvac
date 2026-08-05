import type { Tool, ToolCall, ToolCallError } from '@/schemas'
import {
  generateStableToolCallId,
  validateToolArguments,
  type ParserResult
} from '@/server/utils/tools/shared'

// DeepSeek marks DSML tags with a fullwidth vertical line (U+FF5C `｜`), not
// the ASCII pipe used by the visually similar `<|...|>` markers of the harmony
// and gemma4 dialects — the two must not be conflated.
const OPENER_REGEX = /<｜DSML｜(?:tool_calls|function_calls|invoke)/
// V4 wraps calls in `tool_calls`; V3.2 used `function_calls`. Both carry the
// same invoke/parameter grammar, so the block name is captured and back-
// referenced instead of being hardcoded.
const BLOCK_REGEX = /<｜DSML｜(tool|function)_calls>([\s\S]*?)<\/｜DSML｜\1_calls>/g
const INVOKE_REGEX = /<｜DSML｜invoke([^>]*)>([\s\S]*?)<\/｜DSML｜invoke>/g
const PARAMETER_REGEX = /<｜DSML｜parameter([^>]*)>([\s\S]*?)<\/｜DSML｜parameter>/g
const NAME_ATTR_REGEX = /name="([^"]*)"/
const STRING_ATTR_REGEX = /string="(true|false)"/i

// Fallback for parameters that carry no `string` attribute: lean on the
// declared parameter type, and keep the raw text when it doesn't fit rather
// than dropping an otherwise-usable call.
function coerceBySchemaType(value: string, type?: string): unknown {
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(value)
      return value.length > 0 && !Number.isNaN(n) ? n : value
    }
    case 'boolean': {
      const v = value.toLowerCase()
      if (v === 'true') return true
      if (v === 'false') return false
      return value
    }
    case 'array':
    case 'object':
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    default:
      return value
  }
}

// `string="true"` marks a raw string value, `string="false"` a JSON-encoded
// number, boolean, array or object. The attribute is authoritative when
// present; a malformed `string="false"` payload is a hard parse error because
// there is no safe reading of it.
function coerceParamValue(raw: string, isString: string | undefined, type?: string): unknown {
  const trimmed = raw.trim()
  if (isString === undefined) return coerceBySchemaType(trimmed, type)
  if (isString === 'true') return trimmed
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    throw new Error(
      `invalid JSON for string="false" parameter: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// Parses DeepSeek's DSML tool-call dialect (V3.2 / V4):
//   <｜DSML｜tool_calls>
//   <｜DSML｜invoke name="NAME">
//   <｜DSML｜parameter name="KEY" string="true">VALUE</｜DSML｜parameter>
//   </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
export function parseDsmlFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  if (!OPENER_REGEX.test(text)) {
    return { matched: false, toolCalls, errors }
  }

  const blocks = Array.from(text.matchAll(BLOCK_REGEX), (m) => m[2]!)
  // A block cut off before its close tag still carries complete invokes, so
  // fall back to scanning the whole text instead of losing them.
  const scopes = blocks.length > 0 ? blocks : [text]
  const invokes = scopes.flatMap((scope) => Array.from(scope.matchAll(INVOKE_REGEX)))

  if (invokes.length === 0) {
    return {
      matched: true,
      toolCalls,
      errors: [
        {
          code: 'PARSE_ERROR',
          message: 'DSML tool call block contains no <｜DSML｜invoke name="NAME"> element',
          raw: text.trim()
        }
      ]
    }
  }

  for (const invoke of invokes) {
    const raw = invoke[0]
    const name = NAME_ATTR_REGEX.exec(invoke[1]!)?.[1]?.trim()
    if (!name) {
      errors.push({
        code: 'PARSE_ERROR',
        message: 'DSML invoke is missing a name attribute',
        raw
      })
      continue
    }

    const properties = tools.find((t) => t.name === name)?.parameters?.properties ?? {}

    const args: Record<string, unknown> = {}
    let parseError: string | undefined
    for (const param of invoke[2]!.matchAll(PARAMETER_REGEX)) {
      const attrs = param[1]!
      const key = NAME_ATTR_REGEX.exec(attrs)?.[1]?.trim()
      if (!key) {
        parseError = 'DSML parameter is missing a name attribute'
        break
      }
      const isString = STRING_ATTR_REGEX.exec(attrs)?.[1]?.toLowerCase()
      try {
        args[key] = coerceParamValue(param[2]!, isString, properties[key]?.type)
      } catch (err) {
        parseError = `${key}: ${err instanceof Error ? err.message : String(err)}`
        break
      }
    }
    if (parseError !== undefined) {
      errors.push({ code: 'PARSE_ERROR', message: parseError, raw })
      continue
    }

    const validation = validateToolArguments(name, args, tools)
    if (!validation.isValid && validation.error) {
      errors.push({ ...validation.error, raw })
      continue
    }

    toolCalls.push({
      id: generateStableToolCallId(name, args),
      name,
      arguments: args,
      raw
    })
  }

  return { matched: true, toolCalls, errors }
}
