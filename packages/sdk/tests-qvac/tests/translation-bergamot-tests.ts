import type { TestDefinition, Expectation } from "@tetherto/qvac-test-suite";

const createBergamotTest = (
  testId: string,
  text: string,
  resource: string,
  expectation: Expectation,
  estimatedDurationMs: number = 15000,
  suites?: string[],
): TestDefinition => ({
  testId,
  params: { text, resource },
  expectation,
  ...(suites && { suites }),
  metadata: { category: "translation-bergamot", dependency: resource, estimatedDurationMs },
});

// --- EN → FR (bergamot-en-fr) ---

export const bergamotEnFrBasic = createBergamotTest(
  "translation-bergamot-en-fr-basic",
  "Hello, how are you today?",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["bonjour", "comment", "vous", "aujourd"] },
  15000,
  ["smoke"],
);

export const bergamotEnFrLongText = createBergamotTest(
  "translation-bergamot-en-fr-long-text",
  "The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming.",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["temps", "parc", "oiseaux", "fleurs", "beau"] },
  20000,
);

export const bergamotEnFrShortText = createBergamotTest(
  "translation-bergamot-en-fr-short-text",
  "Thank you very much",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["merci", "beaucoup"] },
  10000,
);

export const bergamotEnFrSpecialChars = createBergamotTest(
  "translation-bergamot-en-fr-special-chars",
  "What's your name? I'm John!",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["nom", "comment", "appel"] },
);

export const bergamotEnFrQuestion = createBergamotTest(
  "translation-bergamot-en-fr-question",
  "Can you tell me where the train station is?",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["gare", "où", "dire"] },
);

export const bergamotEnFrNumbers = createBergamotTest(
  "translation-bergamot-en-fr-numbers",
  "The meeting is at 10:30. We have 25 participants.",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["réunion", "10", "25", "participant"] },
);

export const bergamotEnFrEmptyText: TestDefinition = {
  testId: "translation-bergamot-en-fr-empty-text",
  params: { text: "", resource: "bergamot-en-fr" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-bergamot", dependency: "bergamot-en-fr", estimatedDurationMs: 10000 },
};

export const bergamotEnFrStreaming = createBergamotTest(
  "translation-bergamot-en-fr-streaming",
  "Good morning, how are you?",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["bonjour", "comment", "allez"] },
  15000,
  ["smoke"],
);

export const bergamotEnFrStats = createBergamotTest(
  "translation-bergamot-en-fr-stats",
  "Hello world",
  "bergamot-en-fr",
  { validation: "contains-any", contains: ["bonjour", "monde"] },
);

export const bergamotEnFrBatchBasic: TestDefinition = {
  testId: "translation-bergamot-en-fr-batch-basic",
  params: { texts: ["Good morning", "Good night"], resource: "bergamot-en-fr" },
  expectation: { validation: "contains-any", contains: ["bonjour", "matin", "nuit", "bonne"] },
  metadata: { category: "translation-bergamot", dependency: "bergamot-en-fr", estimatedDurationMs: 15000 },
};

export const bergamotEnFrBatchMultiple: TestDefinition = {
  testId: "translation-bergamot-en-fr-batch-multiple",
  params: {
    texts: ["How are you?", "The weather is nice.", "Thank you.", "Goodbye."],
    resource: "bergamot-en-fr",
  },
  expectation: { validation: "contains-any", contains: ["comment", "temps", "merci", "revoir"] },
  metadata: { category: "translation-bergamot", dependency: "bergamot-en-fr", estimatedDurationMs: 20000 },
};

// --- EN → ES (bergamot-en-es) ---

export const bergamotEnEsBasic = createBergamotTest(
  "translation-bergamot-en-es-basic",
  "Hello, how are you today?",
  "bergamot-en-es",
  { validation: "contains-any", contains: ["hola", "cómo", "estás", "hoy"] },
  15000,
  ["smoke"],
);

export const bergamotEnEsLongText = createBergamotTest(
  "translation-bergamot-en-es-long-text",
  "The weather is beautiful today. I decided to go for a walk in the park.",
  "bergamot-en-es",
  { validation: "contains-any", contains: ["tiempo", "parque", "paseo", "hermoso"] },
  20000,
);

export const bergamotEnEsQuestion = createBergamotTest(
  "translation-bergamot-en-es-question",
  "Where is the nearest hospital?",
  "bergamot-en-es",
  { validation: "contains-any", contains: ["hospital", "dónde", "cercano"] },
);

export const bergamotEnEsStreaming = createBergamotTest(
  "translation-bergamot-en-es-streaming",
  "Good morning, how are you?",
  "bergamot-en-es",
  { validation: "contains-any", contains: ["buenos", "días", "cómo"] },
);

// --- ES → IT via EN pivot (bergamot-es-it-pivot) ---

export const bergamotPivotBasic = createBergamotTest(
  "translation-bergamot-pivot-basic",
  "Era una mañana soleada cuando María decidió visitar el mercado local.",
  "bergamot-es-it-pivot",
  { validation: "contains-any", contains: ["mattina", "sole", "maria", "mercato", "locale", "visita"] },
  30000,
);

export const bergamotPivotStreaming = createBergamotTest(
  "translation-bergamot-pivot-streaming",
  "Buenos días, ¿cómo estás hoy?",
  "bergamot-es-it-pivot",
  { validation: "contains-any", contains: ["buon", "giorno", "come", "stai", "oggi"] },
  30000,
);

export const translationBergamotTests = [
  // EN → FR
  bergamotEnFrBasic,
  bergamotEnFrLongText,
  bergamotEnFrShortText,
  bergamotEnFrSpecialChars,
  bergamotEnFrQuestion,
  bergamotEnFrNumbers,
  bergamotEnFrEmptyText,
  bergamotEnFrStreaming,
  bergamotEnFrStats,
  bergamotEnFrBatchBasic,
  bergamotEnFrBatchMultiple,
  // EN → ES
  bergamotEnEsBasic,
  bergamotEnEsLongText,
  bergamotEnEsQuestion,
  bergamotEnEsStreaming,
  // ES → IT via EN pivot
  bergamotPivotBasic,
  bergamotPivotStreaming,
];
