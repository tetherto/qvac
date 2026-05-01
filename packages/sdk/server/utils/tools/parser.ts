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
    default:
      // Pythonic last: its bare `[name(...)]` form can match payloads that
      // look like other dialects.
      return [
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
