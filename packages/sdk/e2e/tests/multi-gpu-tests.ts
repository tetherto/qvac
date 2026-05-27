import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const multiGpuConfigSmoke: TestDefinition = {
  testId: "multi-gpu-config-smoke",
  params: {
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
  },
  expectation: { validation: "contains-all", contains: ["4"] },
  suites: ["smoke"],
  metadata: {
    category: "multi-gpu",
    dependency: "none",
    estimatedDurationMs: 30000,
  },
};

export const multiGpuEmbedConfigSmoke: TestDefinition = {
  testId: "multi-gpu-embed-config-smoke",
  params: {
    text: "Multi-GPU embedding splits layers across all available GPUs.",
  },
  expectation: { validation: "type", expectedType: "array" },
  suites: ["smoke"],
  metadata: {
    category: "multi-gpu",
    dependency: "none",
    estimatedDurationMs: 30000,
  },
};

export const multiGpuTests = [multiGpuConfigSmoke, multiGpuEmbedConfigSmoke];
