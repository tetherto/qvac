import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const modelInfoGet: TestDefinition = {
  testId: "model-info-get",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "model-info", dependency: "llm", estimatedDurationMs: 5000 },
};

export const modelInfoVerifyFiles: TestDefinition = {
  testId: "model-info-verify-files",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "model-info", dependency: "llm", estimatedDurationMs: 5000 },
};

export const modelInfoMultipleModels: TestDefinition = {
  testId: "model-info-multiple-models",
  params: { models: ["LLAMA_3_2_1B_INST_Q4_0", "GTE_LARGE_FP16"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "model-info", dependency: "llm+embeddings", estimatedDurationMs: 10000 },
};

export const modelInfoPersistsAfterUnload: TestDefinition = {
  testId: "model-info-persists-after-unload",
  params: { modelConstant: "LLAMA_3_2_1B_INST_Q4_0" },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "model-info", dependency: "llm", estimatedDurationMs: 5000 },
};

export const modelInfoTests = [
  modelInfoGet,
  modelInfoVerifyFiles,
  modelInfoMultipleModels,
  modelInfoPersistsAfterUnload,
];
