import type { Tool, ToolCall, ToolCallError } from '@/schemas/index'
import { acceptToolCall, isValidToolCall, type ParserResult } from '@/utils/tools/shared'

// Qwen3.5/3.6 can fuse its two tool templates into one frame, embedding the
// XML `<function=NAME>` token as a bare string key inside the JSON envelope:
//   {"function=NAME","arguments":{...}}  (invalid JSON, not parseable as-is)
// Rewrite only that exact shape to a canonical `{"name":NAME,"arguments":...}`
// frame. Kept deliberately narrow so well-formed JSON frames are never touched.
function repairFunctionEqualsJson(candidate: string): string | undefined {
  const match = /^\{\s*"function=([^"]+)"\s*,\s*"arguments"\s*:\s*([\s\S]+)\}\s*$/.exec(candidate)
  if (!match) return undefined
  return `{"name":${JSON.stringify(match[1])},"arguments":${match[2]}}`
}

function parseHermesJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch (err) {
    const repaired = repairFunctionEqualsJson(candidate)
    if (repaired === undefined) throw err
    return JSON.parse(repaired)
  }
}

// Hermes-style: JSON payload wrapped in `<tool_call>...</tool_call>` tags
export function parseHermesFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = []
  const errors: ToolCallError[] = []

  if (!text.includes('<tool_call>')) {
    return { matched: false, toolCalls, errors }
  }

  // Incomplete frame: open marker without close (cutoff/abort). Recover
  // the inner buffer here — fallthrough to JSON parsers can't strip the
  // `<tool_call>` prefix on its own.
  if (!text.includes('</tool_call>')) {
    return recoverIncompleteHermesFrame(text, tools)
  }

  const toolCallRegex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g
  const matches = Array.from(text.matchAll(toolCallRegex))

  for (const match of matches) {
    const callJson = match[1]
    if (!callJson) continue
    const trimmedJson = callJson.trim()

    let callItem: unknown
    try {
      callItem = parseHermesJson(trimmedJson)
    } catch (error) {
      errors.push({
        code: 'PARSE_ERROR',
        message: `Failed to parse Hermes tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: trimmedJson
      })
      continue
    }

    if (!isValidToolCall(callItem)) {
      errors.push({
        code: 'PARSE_ERROR',
        message: 'Hermes tool call is missing name/arguments',
        raw: trimmedJson
      })
      continue
    }

    const accepted = acceptToolCall(callItem, tools, trimmedJson)
    if (accepted.error) errors.push(accepted.error)
    else toolCalls.push(accepted.call)
  }

  return { matched: true, toolCalls, errors }
}

// Strips a possible truncated close-tag tail (`</tool`, `</tool_c`)
// before parsing. Bounded to buffers that actually contain the open marker.
function recoverIncompleteHermesFrame(text: string, tools: Tool[]): ParserResult {
  const openIdx = text.indexOf('<tool_call>')
  const inner = text.slice(openIdx + '<tool_call>'.length).trim()
  const partialCloseIdx = inner.search(/<\/tool/)
  const candidate = partialCloseIdx === -1 ? inner : inner.slice(0, partialCloseIdx).trim()

  if (candidate.length === 0) {
    return { matched: false, toolCalls: [], errors: [] }
  }

  let parsed: unknown
  try {
    parsed = parseHermesJson(candidate)
  } catch {
    return { matched: false, toolCalls: [], errors: [] }
  }

  if (!isValidToolCall(parsed)) {
    return { matched: false, toolCalls: [], errors: [] }
  }

  const accepted = acceptToolCall(parsed, tools, candidate)
  return accepted.error
    ? { matched: true, toolCalls: [], errors: [accepted.error] }
    : { matched: true, toolCalls: [accepted.call], errors: [] }
}
