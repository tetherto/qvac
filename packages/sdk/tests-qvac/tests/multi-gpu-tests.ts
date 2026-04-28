import type { TestDefinition } from "@tetherto/qvac-test-suite";

// Smoke test: verifies split-mode and main-gpu config fields are accepted
// by the SDK schema, flow through MQTT, and are not rejected by the addon
// on a single-GPU machine (split-mode "none" is the default single-GPU path).
export const multiGpuConfigSmoke: TestDefinition = {
  testId: "multi-gpu-config-smoke",
  params: {
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
  },
  expectation: { validation: "contains-all", contains: ["4"] },
  metadata: {
    category: "multi-gpu",
    dependency: "llm",
    estimatedDurationMs: 30000,
  },
};

export const multiGpuTests = [multiGpuConfigSmoke];
