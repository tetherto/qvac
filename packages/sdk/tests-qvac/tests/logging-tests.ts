import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const addonLoggingLlm: TestDefinition = {
  testId: "addon-logging-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", dependency: "llm", estimatedDurationMs: 10000 },
};

export const addonLoggingEmbed: TestDefinition = {
  testId: "addon-logging-embed",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "embeddings", estimatedDurationMs: 10000 },
};

export const addonLoggingWhisper: TestDefinition = {
  testId: "addon-logging-whisper",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "whisper", estimatedDurationMs: 10000 },
  skip: { reason: "Flaky test disabled (addon-logging-whisper)" },
};

export const addonLoggingSdkServer: TestDefinition = {
  testId: "addon-logging-sdk-server",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "llm", estimatedDurationMs: 10000 },
};

export const addonLoggingInvalidModelId: TestDefinition = {
  testId: "addon-logging-invalid-model-id",
  params: { invalidModelId: "non-existent-model-xyz-12345" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "none", estimatedDurationMs: 5000 },
};

export const addonLoggingDuringInference: TestDefinition = {
  testId: "addon-logging-during-inference",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingInvalidLevel: TestDefinition = {
  testId: "logging-invalid-level",
  params: { logLevel: "invalid_level_xyz" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingRapidLevelSwitch: TestDefinition = {
  testId: "logging-rapid-level-switch",
  params: { levelSequence: ["debug", "warn", "error", "info", "debug", "off", "warn"], switchDelayMs: 50 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingConcurrentOperations: TestDefinition = {
  testId: "logging-concurrent-operations",
  params: { operations: ["completion", "embedding"], runConcurrently: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingPersistAcrossReload: TestDefinition = {
  testId: "logging-persist-across-reload",
  params: { setLogLevel: "debug", unloadModel: true, reloadModel: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingAllAddonsSilent: TestDefinition = {
  testId: "logging-all-addons-silent",
  params: { addonLogLevels: { llm: "off", embedding: "off", whisper: "off", tts: "off", sdk: "off" } },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingLongMessage: TestDefinition = {
  testId: "logging-long-message",
  params: { triggerLongLog: true, expectedMinLength: 1000 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 10000 },
};

export const loggingStreamingStress: TestDefinition = {
  testId: "logging-streaming-stress",
  params: { logLevel: "debug", performMultipleOperations: true, operationCount: 3 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 20000 },
};

export const loggingTimestampAccuracy: TestDefinition = {
  testId: "logging-timestamp-accuracy",
  params: { logLevel: "debug", verifyTimestamps: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingNamespaceFilter: TestDefinition = {
  testId: "logging-namespace-filter",
  params: { enabledNamespaces: ["llamacpp:llm"], disabledNamespaces: ["llamacpp:embed", "whispercpp", "tts"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingTests = [
  addonLoggingLlm,
  addonLoggingEmbed,
  addonLoggingWhisper,
  addonLoggingSdkServer,
  addonLoggingInvalidModelId,
  addonLoggingDuringInference,
  loggingInvalidLevel,
  loggingRapidLevelSwitch,
  loggingConcurrentOperations,
  loggingPersistAcrossReload,
  loggingAllAddonsSilent,
  loggingLongMessage,
  loggingStreamingStress,
  loggingTimestampAccuracy,
  loggingNamespaceFilter,
];
