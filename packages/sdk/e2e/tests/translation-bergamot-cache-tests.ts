import type { TestDefinition } from "@tetherto/qvac-test-suite";

interface BergamotCacheParams {
  pair: string;
}

const cacheReloadTest = (pair: string): TestDefinition => ({
  testId: `translation-bergamot-${pair}-cache-reload`,
  params: { pair } satisfies BergamotCacheParams,
  expectation: { validation: "function", fn: () => true },
  metadata: {
    category: "translation-bergamot-cache",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
});

export const translationBergamotCacheTests: TestDefinition[] = [
  cacheReloadTest("fr-en"),
  cacheReloadTest("en-fr"),
];
