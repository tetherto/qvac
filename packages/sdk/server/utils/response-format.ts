import type { ResponseFormat } from "@/schemas";

// Translates the request-level `responseFormat` into the JSON Schema string
// that the llama.cpp addon's per-request `generationParams.json_schema`
// expects. Returns `undefined` for `{ type: "text" }` (no constraint).
//
// The addon converts the schema to GBNF natively via
// `json_schema_to_grammar()` and applies it for the duration of the request
// only, restoring the prior sampling block afterwards — so this surface is
// safe to use under concurrent completions on the same model. (Tool calling
// still goes through `setupToolGrammar` / `modelConfig.grammar`; see the
// mutual-exclusion check in `completionClientParamsSchema`.)
export function getResponseFormatJsonSchema(
  responseFormat: ResponseFormat,
): string | undefined {
  switch (responseFormat.type) {
    case "text":
      return undefined;
    case "json_object":
      return JSON.stringify({ type: "object" });
    case "json_schema":
      return JSON.stringify(responseFormat.json_schema.schema);
  }
}
