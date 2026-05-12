import type { Tool, ToolCall, ToolCallError, ToolDialect } from "@/schemas";
import {
  stripThinkingBlocks,
  type ParserResult,
} from "@/server/utils/tools/shared";
import {
  parseGemmaFormat,
  parseGenericFormat,
  parseLlamacppFormat,
} from "@/server/utils/tools/parsers/json";
import { parseHermesFormat } from "@/server/utils/tools/parsers/hermes";
import { parsePythonicFormat } from "@/server/utils/tools/parsers/pythonic";
import { parseHarmonyFormat } from "@/server/utils/tools/parsers/harmony";
import { parseQwen35Format } from "@/server/utils/tools/parsers/qwen35";
import { parseGemma4NativeFormat } from "@/server/utils/tools/parsers/gemma4native";

function pickFormatParsers(
  dialect: ToolDialect | undefined,
): Array<(t: string, ts: Tool[]) => ParserResult> {
  switch (dialect) {
    case "pythonic":
      return [parsePythonicFormat];
    case "hermes":
      // Hermes first so frame errors surface; JSON fallbacks then cover
      // unknown JSON-payload models.
      return [parseHermesFormat, parseGemmaFormat, parseLlamacppFormat];
    case "json":
      return [parseGemmaFormat, parseLlamacppFormat];
    case "harmony":
      return [parseHarmonyFormat];
    case "qwen35":
      // Hermes fallback: Qwen3.5 templates sometimes emit OpenAI-style JSON
      // when the native XML format fails; Hermes chain recovers those.
      return [parseQwen35Format, parseHermesFormat];
    case "gemma4":
      // No JSON fallback: Gemma4 emits only its native channel-thought dialect
      // and never falls back to JSON-envelope formats.
      return [parseGemma4NativeFormat];
    default:
      // Gemma4 first: `<|tool_call>` is uniquely distinctive and can't
      // false-match other dialects.
      // Harmony next: `to=functions.` is also uniquely Harmony.
      // Qwen35 before Hermes: defers to Hermes when JSON is inside <tool_call>,
      // so the XML path is recovered without breaking Hermes-JSON payloads.
      // Pythonic last: its bare `[name(...)]` form can match payloads that
      // look like other dialects.
      return [
        parseGemma4NativeFormat,
        parseHarmonyFormat,
        parseQwen35Format,
        parseHermesFormat,
        parseGemmaFormat,
        parseLlamacppFormat,
        parsePythonicFormat,
      ];
  }
}

export function parseToolCalls(
  text: string,
  tools: Tool[],
  dialect?: ToolDialect,
): { toolCalls: ToolCall[]; errors: ToolCallError[] } {
  if (!tools || tools.length === 0) {
    return { toolCalls: [], errors: [] };
  }

  const cleaned = stripThinkingBlocks(text);
  const formatParsers = pickFormatParsers(dialect);

  for (const parser of formatParsers) {
    const result = parser(cleaned, tools);
    if (result.matched) {
      return { toolCalls: result.toolCalls, errors: result.errors };
    }
  }

  const generic = parseGenericFormat(cleaned, tools);
  return { toolCalls: generic.toolCalls, errors: generic.errors };
}
