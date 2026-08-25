import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'
import {
  generateStableToolCallId,
  validateToolArguments,
  type ParserResult
} from '@/utils/tools/shared'

// DeepSeek marks DSML tags with a fullwidth vertical line (U+FF5C `｜`), not
// the ASCII pipe used by the visually similar `<|...|>` markers of the harmony
// and gemma4 dialects — the two must not be conflated. V4 wraps calls in
// `tool_calls`; V3.2 used `function_calls`. Both carry the same invoke/
// parameter grammar, so only the wrapper name differs.
const OPENER_REGEX = /<｜DSML｜(?:tool_calls|function_calls|invoke)/
const INVOKE_OPEN_REGEX = /<｜DSML｜invoke([ \t\r\n][^>]*)?>/g
const INVOKE_CLOSE_TAG = '</｜DSML｜invoke>'
const PARAMETER_REGEX = /<｜DSML｜parameter([ \t\r\n][^>]*)?>([\s\S]*?)<\/｜DSML｜parameter>/g
const NAME_ATTR_REGEX = /(?:^|\s)name="([^"]*)"/
const STRING_ATTR_REGEX = /(?:^|\s)string="(true|false)"/i
const FALLBACK_DIALECT_REGEX = /<tool_call>|"name"\s*:/

function coerceBySchemaType(value: string, type?: string): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value)
      if (value.length === 0 || Number.isNaN(n)) throw new Error(`invalid number value: "${value}"`)
      return n
    }
    case 'integer': {
      const n = Number(value)
      if (value.length === 0 || Number.isNaN(n) || !Number.isInteger(n)) {
        throw new Error(`invalid integer value: "${value}"`)
      }
      return n
    }
    case 'boolean': {
      const v = value.toLowerCase()
      if (v === 'true') return true
      if (v === 'false') return false
      throw new Error(`invalid boolean value: "${value}"`)
    }
    case 'array':
    case 'object':
      return JSON.parse(value)
    default:
      return value
  }
}

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

function collectInvokes(text: string) {
  const openers = Array.from(text.matchAll(INVOKE_OPEN_REGEX))
  return openers.map((opener, i) => {
    const start = opener.index
    const bodyStart = start + opener[0].length
    const limit = openers[i + 1]?.index ?? text.length
    const rel = text.slice(bodyStart, limit).indexOf(INVOKE_CLOSE_TAG)
    const closed = rel !== -1
    const closeAt = bodyStart + rel
    const end = closed ? closeAt + INVOKE_CLOSE_TAG.length : limit
    return {
      attrs: opener[1] ?? '',
      body: closed ? text.slice(bodyStart, closeAt) : '',
      closed,
      start,
      consumedEnd: closed ? end : bodyStart,
      raw: text.slice(start, end).trim()
    }
  })
}

function textOutsideInvokes(text: string, invokes: ReturnType<typeof collectInvokes>) {
  const parts: string[] = []
  let cursor = 0
  for (const invoke of invokes) {
    parts.push(text.slice(cursor, invoke.start))
    cursor = invoke.consumedEnd
  }
  parts.push(text.slice(cursor))
  return parts.join('\n')
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

  // Invokes are collected from the whole text rather than per block: a block
  // cut off before its close tag still carries complete invokes, and a single
  // pass recovers them without re-counting the ones inside closed blocks.
  const invokes = collectInvokes(text)

  if (invokes.length === 0) {
    if (FALLBACK_DIALECT_REGEX.test(text)) {
      return { matched: false, toolCalls, errors }
    }
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
    const raw = invoke.raw
    if (!invoke.closed) {
      errors.push({
        code: 'PARSE_ERROR',
        message: `DSML invoke is missing its ${INVOKE_CLOSE_TAG} close tag`,
        raw
      })
      continue
    }

    const name = NAME_ATTR_REGEX.exec(invoke.attrs)?.[1]?.trim()
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
    for (const param of invoke.body.matchAll(PARAMETER_REGEX)) {
      const attrs = param[1] ?? ''
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

  if (toolCalls.length === 0 && FALLBACK_DIALECT_REGEX.test(textOutsideInvokes(text, invokes))) {
    return { matched: false, toolCalls: [], errors: [] }
  }

  return { matched: true, toolCalls, errors }
}
