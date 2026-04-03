import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const downloadCancelIsolation: TestDefinition = {
  testId: "download-cancel-isolation",
  params: { cancelAtPercent: 1 },
  // expectation is ignored in test executor, it does validation in the executor itself.
  expectation: { validation: "custom", validator: () => true },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
};

export const downloadTests = [downloadCancelIsolation];
