import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

// Coerce raw parameter text to the type declared in the tool's JSON schema.
// String values are raw (not JSON-quoted); arrays/objects are valid JSON.
function coerceParamValue(
  raw: string,
  schema?: { type?: string },
): unknown {
  const trimmed = raw.trim();
  if (!schema?.type) return trimmed;
  switch (schema.type) {
    case "number": {
      if (trimmed.length === 0) throw new Error(`invalid numeric value: ""`);
      const n = Number(trimmed);
      if (Number.isNaN(n)) throw new Error(`invalid numeric value: "${trimmed}"`);
      return n;
    }
    case "integer": {
      if (trimmed.length === 0) throw new Error(`invalid integer value: ""`);
      const n = Number(trimmed);
      if (Number.isNaN(n) || !Number.isInteger(n)) throw new Error(`invalid integer value: "${trimmed}"`);
      return n;
    }
    case "boolean": {
      // Qwen3.5/3.6 intermittently emit Python-style capitalised booleans
      // (`True`/`False`); accept any casing so a valid call isn't dropped.
      const v = trimmed.toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
      throw new Error(`invalid boolean value: "${trimmed}"`);
    }
    case "array":
    case "object":
      return JSON.parse(trimmed);
    default:
      return trimmed;
  }
}

// Parses Qwen3.5/3.6 Pythonic-XML tool-call format:
//   <tool_call>
//   <function=NAME>
//   <parameter=KEY>VALUE</parameter>
//   </function>
//   </tool_call>
// String parameter values are raw text (not JSON-quoted); arrays/objects
// are JSON. Type coercion uses the tool schema; unknown params pass through.
export function parseQwen35Format(text: string, tools: Tool[]): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  if (!text.includes("<tool_call>")) {
    return { matched: false, toolCalls, errors };
  }

  const outerRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const outerMatches = Array.from(text.matchAll(outerRegex));

  if (outerMatches.length === 0) return { matched: false, toolCalls, errors };

  // If no match contains XML function syntax, check if this is JSON format
  // (defer to hermes) or just malformed content (surface as PARSE_ERROR).
  if (!outerMatches.some((m) => m[1]!.includes("<function="))) {
    const looksLikeJson = outerMatches.some((m) => {
      const inner = m[1]!.trim();
      return inner.startsWith("{") || inner.startsWith("[");
    });
    if (looksLikeJson) return { matched: false, toolCalls, errors };
    return {
      matched: true,
      toolCalls,
      errors: outerMatches.map((m) => ({
        code: "PARSE_ERROR" as const,
        message: "Qwen3.5 tool call missing <function=NAME>...</function>",
        raw: m[1]!.trim(),
      })),
    };
  }

  for (const outerMatch of outerMatches) {
    const inner = outerMatch[1]!.trim();

    const fnMatch = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/i.exec(
      inner,
    );
    if (!fnMatch) {
      errors.push({
        code: "PARSE_ERROR",
        message: "Qwen3.5 tool call missing <function=NAME>...</function>",
        raw: inner,
      });
      continue;
    }

    const name = fnMatch[1]!.trim();
    const paramsBlock = fnMatch[2]!;
    const tool = tools.find((t) => t.name === name);
    const schemaProperties = tool?.parameters?.properties ?? {};

    const args: Record<string, unknown> = {};
    let parseError: string | undefined;
    try {
      const paramRegex = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gi;
      let pm: RegExpExecArray | null;
      while ((pm = paramRegex.exec(paramsBlock)) !== null) {
        const paramName = pm[1]!.trim();
        args[paramName] = coerceParamValue(pm[2]!, schemaProperties[paramName]);
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    if (parseError !== undefined) {
      errors.push({ code: "PARSE_ERROR", message: parseError, raw: inner });
      continue;
    }

    const validation = validateToolArguments(name, args, tools);
    if (!validation.isValid && validation.error) {
      errors.push({ ...validation.error, raw: inner });
      continue;
    }

    toolCalls.push({
      id: generateStableToolCallId(name, args),
      name,
      arguments: args,
      raw: inner,
    });
  }

  return { matched: true, toolCalls, errors };
}
