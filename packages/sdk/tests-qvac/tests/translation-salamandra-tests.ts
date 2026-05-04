import type { TestDefinition, Expectation } from "@tetherto/qvac-test-suite";

const createSalamandraTest = (
  testId: string,
  text: string,
  to: string,
  expectation: Expectation,
  opts: { from?: string; context?: string; estimatedDurationMs?: number } = {},
  suites?: string[],
): TestDefinition => ({
  testId,
  params: {
    text,
    to,
    resource: "salamandra",
    ...(opts.from && { from: opts.from }),
    ...(opts.context && { context: opts.context }),
  },
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: "translation-salamandra",
    dependency: "salamandra",
    estimatedDurationMs: opts.estimatedDurationMs ?? 300000,
  },
});

export const salamandraEnEs = createSalamandraTest(
  "translation-salamandra-en-es",
  "Hello, how are you today?",
  "es",
  { validation: "contains-any", contains: ["hola", "cómo", "estás", "hoy", "buenos"] },
  { from: "en" },
  ["smoke"],
);

export const salamandraEsEn = createSalamandraTest(
  "translation-salamandra-es-en",
  "Buenos días, ¿cómo estás hoy?",
  "en",
  { validation: "contains-any", contains: ["good", "morning", "how", "are", "you", "today"] },
  { from: "es" },
);

export const salamandraStreaming: TestDefinition = {
  testId: "translation-salamandra-streaming",
  params: { text: "Hello, how are you today?", from: "en", to: "es", resource: "salamandra" },
  expectation: { validation: "contains-any", contains: ["hola", "cómo", "estás", "hoy", "buenos"] },
  suites: ["smoke"],
  metadata: { category: "translation-salamandra", dependency: "salamandra", estimatedDurationMs: 30000 },
};

export const salamandraStats: TestDefinition = {
  testId: "translation-salamandra-stats",
  params: { text: "Hello world", from: "en", to: "es", resource: "salamandra" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-salamandra", dependency: "salamandra", estimatedDurationMs: 30000 },
};

export const salamandraAutodetect = createSalamandraTest(
  "translation-salamandra-autodetect",
  "Bonjour, comment allez-vous aujourd'hui?",
  "en",
  { validation: "type", expectedType: "string" },
);

export const salamandraContext = createSalamandraTest(
  "translation-salamandra-context",
  "bank",
  "es",
  { validation: "type", expectedType: "string" },
  { from: "en", context: "Use formal language, context is financial institution" },
);

export const salamandraLongText = createSalamandraTest(
  "translation-salamandra-long-text",
  "The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming. It is a perfect day to enjoy nature and relax.",
  "es",
  { validation: "type", expectedType: "string" },
  { from: "en", estimatedDurationMs: 45000 },
);

export const salamandraEmptyText: TestDefinition = {
  testId: "translation-salamandra-empty-text",
  params: { text: "", from: "en", to: "es", resource: "salamandra" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-salamandra", dependency: "salamandra", estimatedDurationMs: 15000 },
};

export const translationSalamandraTests = [
  salamandraEnEs,
  salamandraEsEn,
  salamandraStreaming,
  salamandraStats,
  salamandraAutodetect,
  salamandraContext,
  salamandraLongText,
  salamandraEmptyText,
];
