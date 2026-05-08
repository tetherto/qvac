import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const addonLoggingLlm: TestDefinition = {
  testId: "addon-logging-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "llm", trigger: "llm", estimatedDurationMs: 10000 },
};

export const addonLoggingEmbed: TestDefinition = {
  testId: "addon-logging-embed",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "embeddings", trigger: "embed", estimatedDurationMs: 10000 },
};

export const addonLoggingWhisper: TestDefinition = {
  testId: "addon-logging-whisper",
  params: { audioFileName: "transcription-short-wav.wav" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "whisper", trigger: "whisper", estimatedDurationMs: 20000 },
};

export const addonLoggingParakeet: TestDefinition = {
  testId: "addon-logging-parakeet",
  params: { audioFileName: "transcription-short-wav.wav" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "parakeet-tdt", trigger: "parakeet", estimatedDurationMs: 20000 },
};

export const addonLoggingOcr: TestDefinition = {
  testId: "addon-logging-ocr",
  params: { imageFileName: "ocr-simple-test-png.png" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "ocr", trigger: "ocr", estimatedDurationMs: 30000 },
};

export const addonLoggingTts: TestDefinition = {
  testId: "addon-logging-tts",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "tts-supertonic", trigger: "tts", estimatedDurationMs: 20000 },
};

export const addonLoggingNmt: TestDefinition = {
  testId: "addon-logging-nmt",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "bergamot-en-fr", trigger: "nmt", estimatedDurationMs: 15000 },
};

export const addonLoggingDiffusion: TestDefinition = {
  testId: "addon-logging-diffusion",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", dependency: "diffusion", trigger: "diffusion", estimatedDurationMs: 120000 },
};

export const addonLoggingSdkServer: TestDefinition = {
  testId: "addon-logging-sdk-server",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "addon-logging", target: "sdk-server", estimatedDurationMs: 10000 },
};

export const addonLoggingInvalidModelId: TestDefinition = {
  testId: "addon-logging-invalid-model-id",
  params: { invalidModelId: "non-existent-model-xyz-12345" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "addon-logging", handler: "invalid-model-id", estimatedDurationMs: 5000 },
};

export const addonLoggingDuringInference: TestDefinition = {
  testId: "addon-logging-during-inference",
  params: { streaming: true, operationCount: 1 },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "addon-logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingInvalidLevel: TestDefinition = {
  testId: "logging-invalid-level",
  params: { logLevel: "invalid_level_xyz" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingRapidLevelSwitch: TestDefinition = {
  testId: "logging-rapid-level-switch",
  params: { levelSequence: ["debug", "warn", "error", "info", "debug", "off", "warn"], switchDelayMs: 50 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingConcurrentOperations: TestDefinition = {
  testId: "logging-concurrent-operations",
  params: { operations: ["completion", "embedding"], runConcurrently: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "concurrent", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingPersistAcrossReload: TestDefinition = {
  testId: "logging-persist-across-reload",
  params: { setLogLevel: "debug", unloadModel: true, reloadModel: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "reload", dependency: "llm", estimatedDurationMs: 15000 },
};

export const loggingAllAddonsSilent: TestDefinition = {
  testId: "logging-all-addons-silent",
  params: { addonLogLevels: { llm: "off", embedding: "off", whisper: "off", tts: "off", sdk: "off" } },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingLongMessage: TestDefinition = {
  testId: "logging-long-message",
  params: { triggerLongLog: true, expectedMinLength: 1000 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 10000 },
};

export const loggingStreamingStress: TestDefinition = {
  testId: "logging-streaming-stress",
  params: { logLevel: "debug", performMultipleOperations: true, operationCount: 3 },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 20000 },
};

export const loggingTimestampAccuracy: TestDefinition = {
  testId: "logging-timestamp-accuracy",
  params: { logLevel: "debug", verifyTimestamps: true },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 5000 },
};

export const loggingNamespaceFilter: TestDefinition = {
  testId: "logging-namespace-filter",
  params: { enabledNamespaces: ["llamacpp:llm"], disabledNamespaces: ["llamacpp:embed", "whispercpp", "tts"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "logging", handler: "during-inference", dependency: "llm", estimatedDurationMs: 5000 },
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
