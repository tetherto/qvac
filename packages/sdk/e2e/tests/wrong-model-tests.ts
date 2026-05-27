import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const wrongModelTranscribeOnLlm: TestDefinition = {
  testId: "wrong-model-transcribe-on-llm",
  params: {},
  expectation: {
    validation: "throws-error",
    errorContains: "does not support transcribe",
  },
  suites: ["smoke"],
  metadata: {
    category: "wrong-model",
    dependency: "llm",
    estimatedDurationMs: 5000,
  },
};

export const wrongModelTests = [wrongModelTranscribeOnLlm];
