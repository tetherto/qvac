import type { ToolDialect } from "@/schemas";

/**
 * Detects the tool-call dialect from a model's registry name and file path.
 * Defaults to "hermes" (its parser chain also covers unknown JSON-payload
 * models). Bypass with `completion({ toolDialect })`.
 */
export function detectToolDialectFromName(
  name: string | undefined,
  path: string,
): ToolDialect {
  const basename = path.toLowerCase().split(/[/\\]/).pop() ?? "";
  const tag = `${(name ?? "").toLowerCase()}|${basename}`;

  if (/lfm[_-]?\d/.test(tag)) return "pythonic";
  return "hermes";
}
