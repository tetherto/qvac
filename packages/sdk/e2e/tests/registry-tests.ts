import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const registryListBasic: TestDefinition = {
  testId: "registry-list-basic",
  params: { action: "list" },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryListReturnsModels: TestDefinition = {
  testId: "registry-list-returns-models",
  params: { action: "list" },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  suites: ["smoke"],
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryListEntryShape: TestDefinition = {
  testId: "registry-list-entry-shape",
  params: { action: "list", validateShape: true },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registrySearchNoFilters: TestDefinition = {
  testId: "registry-search-no-filters",
  params: { action: "search" },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registrySearchByEngineLlm: TestDefinition = {
  testId: "registry-search-by-engine-llm",
  params: { action: "search", engine: "llamacpp-completion" },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  suites: ["smoke"],
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registrySearchByFilterWhisper: TestDefinition = {
  testId: "registry-search-by-filter-whisper",
  params: { action: "search", filter: "whisper" },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registrySearchByQuantization: TestDefinition = {
  testId: "registry-search-by-quantization",
  params: { action: "search", quantization: "q4" },
  expectation: { validation: "type", expectedType: "array", minLength: 1 },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registrySearchNoResults: TestDefinition = {
  testId: "registry-search-no-results",
  params: { action: "search", filter: "nonexistent-model-xyz-12345", expectEmpty: true },
  expectation: { validation: "type", expectedType: "array" },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryGetModelValid: TestDefinition = {
  testId: "registry-get-model-valid",
  params: { action: "getModel", useFirstFromList: true },
  expectation: { validation: "regex", pattern: ".+" },
  suites: ["smoke"],
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryGetModelNotFound: TestDefinition = {
  testId: "registry-get-model-not-found",
  params: { action: "getModel", registryPath: "nonexistent/model/path.gguf", registrySource: "nonexistent-source" },
  expectation: { validation: "throws-error", errorContains: "not found" },
  suites: ["smoke"],
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryGetModelMatchesList: TestDefinition = {
  testId: "registry-get-model-matches-list",
  params: { action: "getModel", useFirstFromList: true, matchList: true },
  expectation: { validation: "regex", pattern: ".+" },
  metadata: { category: "registry", dependency: "none", estimatedDurationMs: 5000 },
};

export const registryTests = [
  registryListBasic,
  registryListReturnsModels,
  registryListEntryShape,
  registrySearchNoFilters,
  registrySearchByEngineLlm,
  registrySearchByFilterWhisper,
  registrySearchByQuantization,
  registrySearchNoResults,
  registryGetModelValid,
  registryGetModelNotFound,
  registryGetModelMatchesList,
];
