import { TOOLS_MODE, type LlmConfig } from "@/schemas";

/**
 * Converts an LlmConfig into the flat string-keyed map the C++ addon expects.
 *
 * JS-only fields excluded from the output (must NOT be forwarded to the addon):
 *   - modelType   (schema discriminant, meaningless at C++ level)
 *   - system_prompt  (JS-side history seeding only; C++ removed --system-prompt in 8189)
 */
export function transformLlmConfig(llmConfig: LlmConfig) {
  const transformed = JSON.parse(
    JSON.stringify(llmConfig, (key: string, v: unknown) =>
      key === "modelType" || key === "system_prompt"
        ? undefined
        : key === "stop_sequences"
          ? Array.isArray(v)
            ? v.join(", ")
            : v
          : typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : v,
    ).replace(
      /"([a-z][A-Za-z]*)":/g,
      (_, key: string) =>
        `"${key.replace(/[A-Z]/g, (l: string) => `_${l.toLowerCase()}`)}":`,
    ),
  ) as Record<string, string>;

  if ("stop_sequences" in transformed) {
    transformed["reverse_prompt"] = transformed["stop_sequences"];
    delete transformed["stop_sequences"];
  }

  if ("opencl_cache_dir" in transformed) {
    transformed["openclCacheDir"] = transformed["opencl_cache_dir"];
    delete transformed["opencl_cache_dir"];
  }

  if ("tools_mode" in transformed) {
    if (transformed["tools_mode"] === TOOLS_MODE.dynamic) {
      transformed["tools_compact"] = "true";
    }
    delete transformed["tools_mode"];
  }

  return transformed;
}
