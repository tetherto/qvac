import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  isValidToolCall,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

// Hermes-style: JSON payload wrapped in `<tool_call>...</tool_call>` tags
// (Nous Hermes 2 Pro, Qwen 2.5/3, Mistral instruct).
export function parseHermesFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  // Match on marker presence so half-formed frames surface as Hermes errors
  // rather than falling through to the generic JSON regex.
  if (!text.includes("<tool_call>")) {
    return { matched: false, toolCalls, errors };
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
