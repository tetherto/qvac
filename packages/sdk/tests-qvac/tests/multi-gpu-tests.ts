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
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
  skip: {
    reason: "MultiGpuExecutor is not registered in the mobile consumer; multi-GPU tensor splitting is a desktop configuration",
    platforms: ["mobile-ios", "mobile-android"],
  },
};

export const multiGpuTests = [multiGpuConfigSmoke];
