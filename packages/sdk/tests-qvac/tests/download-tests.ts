import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const downloadCancelIsolation: TestDefinition = {
  testId: "download-cancel-isolation",
  params: { cancelAtPercent: 1 },
  expectation: { validation: "custom" },
  metadata: {
    category: "download",
    dependency: "none",
    estimatedDurationMs: 180000,
  },
};

export const downloadTests = [downloadCancelIsolation];
