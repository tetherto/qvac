import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const addonLoggingLlm: TestDefinition = {
  testId: "addon-logging-llm",
  params: { handler: "addon-logging", trigger: "llm" },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", dependency: "llm", estimatedDurationMs: 10000 },
};

export const addonLoggingEmbed: TestDefinition = {
  testId: "addon-logging-embed",
  params: { handler: "addon-logging", trigger: "embed" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "embeddings", estimatedDurationMs: 10000 },
};

export const addonLoggingWhisper: TestDefinition = {
  testId: "addon-logging-whisper",
  params: { handler: "addon-logging", trigger: "whisper", audioFileName: "transcription-short-wav.wav" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "whisper", estimatedDurationMs: 20000 },
};

export const addonLoggingParakeet: TestDefinition = {
  testId: "addon-logging-parakeet",
  params: { handler: "addon-logging", trigger: "parakeet", audioFileName: "transcription-short-wav.wav" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "parakeet-tdt", estimatedDurationMs: 20000 },
};

export const addonLoggingOcr: TestDefinition = {
  testId: "addon-logging-ocr",
  params: { handler: "addon-logging", trigger: "ocr", imageFileName: "small-64.jpg" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "ocr", estimatedDurationMs: 30000 },
};

export const addonLoggingTts: TestDefinition = {
  testId: "addon-logging-tts",
  params: { handler: "addon-logging", trigger: "tts" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "tts-supertonic", estimatedDurationMs: 20000 },
};

export const addonLoggingNmt: TestDefinition = {
  testId: "addon-logging-nmt",
  params: { handler: "addon-logging", trigger: "nmt" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "bergamot-en-fr", estimatedDurationMs: 15000 },
};

export const addonLoggingDiffusion: TestDefinition = {
  testId: "addon-logging-diffusion",
  params: { handler: "addon-logging", trigger: "diffusion" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", dependency: "diffusion", estimatedDurationMs: 120000 },
};

export const addonLoggingSdkServer: TestDefinition = {
  testId: "addon-logging-sdk-server",
  params: { handler: "addon-logging" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", target: "sdk-server", estimatedDurationMs: 10000 },
};

export const addonLoggingInvalidModelId: TestDefinition = {
  testId: "addon-logging-invalid-model-id",
  params: { handler: "invalid-model-id", invalidModelId: "non-existent-model-xyz-12345" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", estimatedDurationMs: 5000 },
};

export const addonLoggingDuringInference: TestDefinition = {
  testId: "addon-logging-during-inference",
  params: { handler: "during-inference", streaming: true, operationCount: 1 },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingInvalidLevel: TestDefinition = {
  testId: "logging-invalid-level",
  params: { handler: "during-inference", logLevel: "invalid_level_xyz" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingRapidLevelSwitch: TestDefinition = {
  testId: "logging-rapid-level-switch",
  params: { handler: "during-inference", levelSequence: ["debug", "warn", "error", "info", "debug", "off", "warn"], switchDelayMs: 50 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingConcurrentOperations: TestDefinition = {
  testId: "logging-concurrent-operations",
  params: { handler: "concurrent", operations: ["completion", "embedding"], runConcurrently: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingPersistAcrossReload: TestDefinition = {
  testId: "logging-persist-across-reload",
  params: { handler: "reload", setLogLevel: "debug", unloadModel: true, reloadModel: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingAllAddonsSilent: TestDefinition = {
  testId: "logging-all-addons-silent",
  params: { handler: "during-inference", addonLogLevels: { llm: "off", embedding: "off", whisper: "off", tts: "off", sdk: "off" } },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingLongMessage: TestDefinition = {
  testId: "logging-long-message",
  params: { handler: "during-inference", triggerLongLog: true, expectedMinLength: 1000 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 10000 },
};

export const loggingStreamingStress: TestDefinition = {
  testId: "logging-streaming-stress",
  params: { handler: "during-inference", logLevel: "debug", performMultipleOperations: true, operationCount: 3 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 20000 },
};

export const loggingTimestampAccuracy: TestDefinition = {
  testId: "logging-timestamp-accuracy",
  params: { handler: "during-inference", logLevel: "debug", verifyTimestamps: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingNamespaceFilter: TestDefinition = {
  testId: "logging-namespace-filter",
  params: { handler: "during-inference", enabledNamespaces: ["llamacpp:llm"], disabledNamespaces: ["llamacpp:embed", "whispercpp", "tts"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingTests = [
  addonLoggingLlm,
  addonLoggingEmbed,
  addonLoggingWhisper,
  addonLoggingParakeet,
  addonLoggingOcr,
  addonLoggingTts,
  addonLoggingNmt,
  addonLoggingDiffusion,
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
