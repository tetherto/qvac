import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const loadedModelInfoLocalHappy: TestDefinition = {
  testId: "loaded-model-info-local-happy",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: {
    category: "loaded-model-info",
    dependency: "llm",
    estimatedDurationMs: 5000,
  },
};

export const loadedModelInfoNotFound: TestDefinition = {
  testId: "loaded-model-info-not-found",
  params: { modelId: "nonexistent-model-id-deadbeef" },
  expectation: {
    validation: "throws-error",
    errorContains: "not found",
  },
  suites: ["smoke"],
  metadata: {
    category: "loaded-model-info",
    dependency: "none",
    estimatedDurationMs: 2000,
  },
};

export const loadedModelInfoTests = [
  loadedModelInfoLocalHappy,
  loadedModelInfoNotFound,
];
