import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

// Transliterates Gemma 4's JS-literal argument body to valid JSON so it can
// be parsed with JSON.parse. The body uses:
//   - <|"|>...<|"|> instead of "..." for string values
//   - bare (unquoted) object keys
// Strategy: split by <|"|> tokens so structural parts (even indices) and
// string value parts (odd indices) are processed separately, preventing
// the key-quoting regex from matching `, key:` patterns inside string values.
function gemmaArgsToJson(argsRaw: string): string {
  const parts = ("{" + argsRaw + "}").split(/<\|"\|>/);
  return parts
    .map((part, i) =>
      i % 2 === 0
        ? part.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
        : '"' + part.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + '"',
    )
    .join("");
}

// Parses Gemma 4's native tool-call dialect:
//   <|tool_call>call:NAME{key:<|"|>val<|"|>,key2:bareNum,...}<tool_call|>
// Keys are bare identifiers; string values are wrapped in <|"|>...<|"|>;
// numbers/booleans are bare literals; nested objects/arrays use JS-literal
// syntax throughout. Transliterates to JSON then parses.
export function parseGemma4NativeFormat(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  if (!text.includes("<|tool_call>")) {
    return { matched: false, toolCalls, errors };
  }

  const callRegex = /<\|tool_call>call:([A-Za-z_][\w-]*)\{([\s\S]*?)\}<tool_call\|>/g;
  const matches = Array.from(text.matchAll(callRegex));

  if (matches.length === 0) return { matched: false, toolCalls, errors };

  for (const match of matches) {
    const name = match[1]!;
    const argsRaw = match[2]!;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(gemmaArgsToJson(argsRaw)) as Record<string, unknown>;
    } catch (err) {
      errors.push({
        code: "PARSE_ERROR",
        message: `Failed to parse Gemma 4 tool call arguments: ${err instanceof Error ? err.message : String(err)}`,
        raw: match[0],
      });
      continue;
    }

    const validation = validateToolArguments(name, args, tools);
    if (!validation.isValid && validation.error) {
      errors.push({ ...validation.error, raw: match[0] });
      continue;
    }

    toolCalls.push({
      id: generateStableToolCallId(name, args),
      name,
      arguments: args,
      raw: match[0],
    });
  }

  return { matched: true, toolCalls, errors };
}
