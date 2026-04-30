import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  isValidToolCall,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

// Hermes-style: JSON payload wrapped in `<tool_call>...</tool_call>` tags
export function parseHermesFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  if (!text.includes("<tool_call>")) {
    return { matched: false, toolCalls, errors };
  }

  // Incomplete frame: open marker without close (cutoff/abort). Recover
  // the inner buffer here — fallthrough to JSON parsers can't strip the
  // `<tool_call>` prefix on its own.
  if (!text.includes("</tool_call>")) {
    return recoverIncompleteHermesFrame(text, tools);
  }

  const toolCallRegex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/g;
  const matches = Array.from(text.matchAll(toolCallRegex));

  for (const match of matches) {
    const callJson = match[1];
    if (!callJson) continue;
    const trimmedJson = callJson.trim();

    let callItem: unknown;
    try {
      callItem = JSON.parse(trimmedJson);
    } catch (error) {
      errors.push({
        code: "PARSE_ERROR",
        message: `Failed to parse Hermes tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: trimmedJson,
      });
      continue;
    }

    if (!isValidToolCall(callItem)) {
      errors.push({
        code: "PARSE_ERROR",
        message: "Hermes tool call is missing name/arguments",
        raw: trimmedJson,
      });
      continue;
    }

    const call = callItem;

    const validation = validateToolArguments(
      call.name,
      call.arguments,
      tools,
    );

    if (!validation.isValid && validation.error) {
      errors.push({
        ...validation.error,
        raw: trimmedJson,
      });
      continue;
    }

    toolCalls.push({
      id: call.id || generateStableToolCallId(call.name, call.arguments),
      name: call.name,
      arguments: call.arguments,
      raw: trimmedJson,
    });
  }

  return { matched: true, toolCalls, errors };
}

// Strips a possible truncated close-tag tail (`</tool`, `</tool_c`)
// before parsing. Bounded to buffers that actually contain the open marker.
function recoverIncompleteHermesFrame(
  text: string,
  tools: Tool[],
): ParserResult {
  const openIdx = text.indexOf("<tool_call>");
  const inner = text.slice(openIdx + "<tool_call>".length).trim();
  const partialCloseIdx = inner.search(/<\/tool/);
  const candidate =
    partialCloseIdx === -1 ? inner : inner.slice(0, partialCloseIdx).trim();

  if (candidate.length === 0) {
    return { matched: false, toolCalls: [], errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { matched: false, toolCalls: [], errors: [] };
  }

  if (!isValidToolCall(parsed)) {
    return { matched: false, toolCalls: [], errors: [] };
  }

  const validation = validateToolArguments(parsed.name, parsed.arguments, tools);
  if (!validation.isValid && validation.error) {
    return {
      matched: true,
      toolCalls: [],
      errors: [{ ...validation.error, raw: candidate }],
    };
  }

  return {
    matched: true,
    toolCalls: [
      {
        id: parsed.id || generateStableToolCallId(parsed.name, parsed.arguments),
        name: parsed.name,
        arguments: parsed.arguments,
        raw: candidate,
      },
    ],
    errors: [],
  };
}
