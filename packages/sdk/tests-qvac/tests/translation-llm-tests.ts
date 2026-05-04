import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createLlmTest = (
  testId: string,
  text: string,
  to: string,
  opts: { from?: string; context?: string; estimatedDurationMs?: number } = {},
  suites?: string[],
): TestDefinition => ({
  testId,
  params: {
    text,
    to,
    resource: "llm",
    ...(opts.from && { from: opts.from }),
    ...(opts.context && { context: opts.context }),
  },
  expectation: { validation: "type", expectedType: "string" },
  ...(suites && { suites }),
  metadata: {
    category: "translation-llm",
    dependency: "llm",
    estimatedDurationMs: opts.estimatedDurationMs ?? 90000,
  },
});

export const llmEnEs = createLlmTest(
  "translation-llm-en-es",
  "Hello, how are you today?",
  "es",
  { from: "en" },
  ["smoke"],
);

export const llmEnFr = createLlmTest(
  "translation-llm-en-fr",
  "Good morning, how are you?",
  "fr",
  { from: "en" },
);

export const llmEsEn = createLlmTest(
  "translation-llm-es-en",
  "Buenos días, ¿cómo estás hoy?",
  "en",
  { from: "es" },
);

export const llmAutodetect = createLlmTest(
  "translation-llm-autodetect",
  "Bonjour, comment allez-vous aujourd'hui?",
  "en",
);

export const llmStreaming: TestDefinition = {
  testId: "translation-llm-streaming",
  params: { text: "Hello, how are you today?", from: "en", to: "es", resource: "llm" },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "translation-llm", dependency: "llm", estimatedDurationMs: 30000 },
};

export const llmStats: TestDefinition = {
  testId: "translation-llm-stats",
  params: { text: "Hello world", from: "en", to: "es", resource: "llm" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-llm", dependency: "llm", estimatedDurationMs: 30000 },
};

export const llmContext = createLlmTest(
  "translation-llm-context",
  "bank",
  "es",
  { from: "en", context: "Use formal language, context is financial institution" },
);

export const llmLongText = createLlmTest(
  "translation-llm-long-text",
  "The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming. It is a perfect day to enjoy nature and relax.",
  "es",
  { from: "en", estimatedDurationMs: 45000 },
);

export const llmEmptyText: TestDefinition = {
  testId: "translation-llm-empty-text",
  params: { text: "", from: "en", to: "es", resource: "llm" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-llm", dependency: "llm", estimatedDurationMs: 15000 },
};

export const translationLlmTests = [
  llmEnEs,
  llmEnFr,
  llmEsEn,
  llmAutodetect,
  llmStreaming,
  llmStats,
  llmContext,
  llmLongText,
  llmEmptyText,
];
