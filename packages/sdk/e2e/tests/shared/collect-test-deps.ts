import type { TestDefinition } from "@tetherto/qvac-test-suite";

/**
 * Collect ResourceManager dep keys declared in test `metadata`:
 *   - `metadata.dependency: "llm"`             — single
 *   - `metadata.dependencies: ["llm", "ocr"]`  — multi
 * The sentinel `"none"` (used by tests that intentionally pre-load nothing)
 * is dropped. Result is feed-ready for `downloadAllOnce({ allowedDeps })`.
 */
export function collectTestDeps(tests: readonly TestDefinition[]): Set<string> {
  const deps = new Set<string>();
  for (const test of tests) {
    const meta = test.metadata as Record<string, unknown> | undefined;
    if (!meta) continue;

    const single = meta["dependency"];
    if (typeof single === "string" && single.length > 0 && single !== "none") {
      deps.add(single);
    }

    const multi = meta["dependencies"];
    if (Array.isArray(multi)) {
      for (const dep of multi) {
        if (typeof dep === "string" && dep.length > 0 && dep !== "none") {
          deps.add(dep);
        }
      }
    }
  }
  return deps;
}
