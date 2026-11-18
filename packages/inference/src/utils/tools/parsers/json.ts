import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'
import { acceptToolCall, isValidToolCall, type ParserResult } from '@/utils/tools/shared'

export function parseGemmaFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { matched: false, toolCalls, errors }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('tool_calls' in parsed) ||
    !Array.isArray(parsed.tool_calls)
  ) {
    return { matched: false, toolCalls, errors }
  }

  for (const callItem of (parsed as { tool_calls: unknown[] }).tool_calls) {
    if (!isValidToolCall(callItem)) {
      errors.push({
        code: 'PARSE_ERROR',
        message: 'Gemma tool_calls entry is missing name/arguments',
        raw: JSON.stringify(callItem)
      })
      continue
    }

    const accepted = acceptToolCall(callItem, tools, JSON.stringify(callItem))
    if (accepted.error) errors.push(accepted.error)
    else toolCalls.push(accepted.call)
  }

  return { matched: true, toolCalls, errors }
}

export function parseLlamacppFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  let parsedItem: unknown
  try {
    parsedItem = JSON.parse(text)
  } catch {
    return { matched: false, toolCalls, errors }
  }

  if (!isValidToolCall(parsedItem)) {
    return { matched: false, toolCalls, errors }
  }

  const accepted = acceptToolCall(parsedItem, tools, text)
  if (accepted.error) errors.push(accepted.error)
  else toolCalls.push(accepted.call)

  return { matched: true, toolCalls, errors }
}

// Last-resort fallback: loose JSON `{"name":..., "arguments":...}` objects
// anywhere in the text. Runs after dialect-specific parsers all miss.
export function parseGenericFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  const jsonObjectRegex = /\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}/g
  const matches = Array.from(text.matchAll(jsonObjectRegex))
  let matched = false

  for (const [i, match] of matches.entries()) {
    // A call followed by more prose is an example, not a call made at the end of the turn.
    const end = match.index + match[0].length
    if (text.slice(end, matches[i + 1]?.index ?? text.length).trim()) continue
    matched = true
    try {
      const objItem = JSON.parse(match[0]) as unknown
      if (isValidToolCall(objItem)) {
        const accepted = acceptToolCall(objItem, tools, match[0])
        if (accepted.error) errors.push(accepted.error)
        else toolCalls.push(accepted.call)
      }
    } catch (error) {
      errors.push({
        code: 'PARSE_ERROR',
        message: `Failed to parse generic tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: match[0]
      })
    }
  }

  return { matched, toolCalls, errors }
}
