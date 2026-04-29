import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  isValidToolCall,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

export function parseGemmaFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { matched: false, toolCalls, errors };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("tool_calls" in parsed) ||
    !Array.isArray(parsed.tool_calls)
  ) {
    return { matched: false, toolCalls, errors };
  }

  for (const callItem of (parsed as { tool_calls: unknown[] }).tool_calls) {
    if (!isValidToolCall(callItem)) {
      errors.push({
        code: "PARSE_ERROR",
        message: "Gemma tool_calls entry is missing name/arguments",
        raw: JSON.stringify(callItem),
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
        raw: JSON.stringify(call),
      });
      continue;
    }

    toolCalls.push({
      id: call.id || generateStableToolCallId(call.name, call.arguments),
      name: call.name,
      arguments: call.arguments,
      raw: JSON.stringify(call),
    });
  }

  return { matched: true, toolCalls, errors };
}

export function parseLlamacppFormat(
  text: string,
  tools: Tool[],
): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  let parsedItem: unknown;
  try {
    parsedItem = JSON.parse(text);
  } catch {
    return { matched: false, toolCalls, errors };
  }

  if (!isValidToolCall(parsedItem)) {
    return { matched: false, toolCalls, errors };
  }

  const parsed = parsedItem;

  const validation = validateToolArguments(
    parsed.name,
    parsed.arguments,
    tools,
  );

  if (!validation.isValid && validation.error) {
    errors.push({
      ...validation.error,
      raw: text,
    });
  } else {
    toolCalls.push({
      id: parsed.id || generateStableToolCallId(parsed.name, parsed.arguments),
      name: parsed.name,
      arguments: parsed.arguments,
      raw: text,
    });
  }

  return { matched: true, toolCalls, errors };
}

// Last-resort fallback: loose JSON `{"name":..., "arguments":...}` objects
// anywhere in the text. Runs after dialect-specific parsers all miss.
export function parseGenericFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  const jsonObjectRegex = /\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  let matched = false;

  while ((match = jsonObjectRegex.exec(text)) !== null) {
    matched = true;
    try {
      const objItem = JSON.parse(match[0]) as unknown;
      if (isValidToolCall(objItem)) {
        const obj = objItem;

        const validation = validateToolArguments(
          obj.name,
          obj.arguments,
          tools,
        );

        if (!validation.isValid && validation.error) {
          errors.push({
            ...validation.error,
            raw: match[0],
          });
          continue;
        }

        toolCalls.push({
          id: obj.id || generateStableToolCallId(obj.name, obj.arguments),
          name: obj.name,
          arguments: obj.arguments,
          raw: match[0],
        });
      }
    } catch (error) {
      errors.push({
        code: "PARSE_ERROR",
        message: `Failed to parse generic tool call: ${error instanceof Error ? error.message : String(error)}`,
        raw: match[0],
      });
    }
  }

  return { matched, toolCalls, errors };
}
