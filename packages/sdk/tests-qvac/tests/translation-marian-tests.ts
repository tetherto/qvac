import type { TestDefinition, Expectation } from "@tetherto/qvac-test-suite";

const createMarianTest = (
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
  metadata: { category: "translation-marian", dependency: resource, estimatedDurationMs },
});

// --- DE → EN (marian-de-en) ---

export const marianDeEnBasic = createMarianTest(
  "translation-marian-de-en-basic",
  "Hallo, wie geht es dir heute?",
  "marian-de-en",
  { validation: "contains-any", contains: ["hello", "how", "are", "you", "today"] },
  15000,
  ["smoke"],
);

export const marianDeEnLongText = createMarianTest(
  "translation-marian-de-en-long-text",
  "Der schnelle braune Fuchs springt über den faulen Hund. Dieser Satz enthält viele häufige Buchstaben. Die maschinelle Übersetzung hat in den letzten Jahren große Fortschritte gemacht, wobei neuronale maschinelle Übersetzungsmodelle beeindruckende Ergebnisse erzielen.",
  "marian-de-en",
  { validation: "contains-any", contains: ["fox", "dog", "translation", "machine", "neural"] },
  20000,
);

export const marianDeEnShortText = createMarianTest(
  "translation-marian-de-en-short-text",
  "Ja",
  "marian-de-en",
  { validation: "contains-any", contains: ["yes", "yeah"] },
  10000,
);

export const marianDeEnSpecialChars = createMarianTest(
  "translation-marian-de-en-special-chars",
  "Hallo! Wie geht's dir? Das kostet 50€ - nicht $60!",
  "marian-de-en",
  { validation: "contains-any", contains: ["hello", "how", "cost", "50"] },
);

export const marianDeEnNumbers = createMarianTest(
  "translation-marian-de-en-numbers",
  "Das Treffen ist um 10:30 Uhr. Wir haben 25 Teilnehmer.",
  "marian-de-en",
  { validation: "contains-any", contains: ["meeting", "10:30", "25", "participant"] },
);

export const marianDeEnQuestion = createMarianTest(
  "translation-marian-de-en-question",
  "Können Sie mir bitte sagen, wo der Bahnhof ist? Wie weit ist es von hier?",
  "marian-de-en",
  { validation: "contains-any", contains: ["station", "where", "far", "tell"] },
);

export const marianDeEnFormal = createMarianTest(
  "translation-marian-de-en-formal",
  "Sehr geehrte Damen und Herren, hiermit möchte ich mich für die Stelle bewerben.",
  "marian-de-en",
  { validation: "contains-any", contains: ["dear", "sir", "madam", "apply", "position"] },
);

export const marianDeEnEmptyText: TestDefinition = {
  testId: "translation-marian-de-en-empty-text",
  params: { text: "", resource: "marian-de-en" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-marian", dependency: "marian-de-en", estimatedDurationMs: 10000 },
};

export const marianDeEnStreaming = createMarianTest(
  "translation-marian-de-en-streaming",
  "Guten Tag, wie geht es Ihnen?",
  "marian-de-en",
  { validation: "contains-any", contains: ["good", "day", "how", "are"] },
  15000,
  ["smoke"],
);

export const marianDeEnStats = createMarianTest(
  "translation-marian-de-en-stats",
  "Hallo Welt",
  "marian-de-en",
  { validation: "contains-any", contains: ["hello", "world"] },
);

export const marianDeEnBatchBasic: TestDefinition = {
  testId: "translation-marian-de-en-batch-basic",
  params: { texts: ["Guten Morgen", "Gute Nacht"], resource: "marian-de-en" },
  expectation: { validation: "contains-any", contains: ["morning", "night", "good"] },
  suites: ["smoke"],
  metadata: { category: "translation-marian", dependency: "marian-de-en", estimatedDurationMs: 15000 },
};

export const marianDeEnBatchMultiple: TestDefinition = {
  testId: "translation-marian-de-en-batch-multiple",
  params: {
    texts: ["Wie geht es dir?", "Das Wetter ist schön.", "Ich habe Hunger.", "Auf Wiedersehen.", "Vielen Dank."],
    resource: "marian-de-en",
  },
  expectation: { validation: "contains-any", contains: ["how", "weather", "hunger", "goodbye", "thank"] },
  metadata: { category: "translation-marian", dependency: "marian-de-en", estimatedDurationMs: 25000 },
};

// --- EN → ES (marian-en-es) ---

export const marianEnEsBasic = createMarianTest(
  "translation-marian-en-es-basic",
  "Hello, how are you today?",
  "marian-en-es",
  { validation: "contains-any", contains: ["hola", "cómo", "estás", "hoy"] },
  15000,
  ["smoke"],
);

export const marianEnEsLongText = createMarianTest(
  "translation-marian-en-es-long-text",
  "The weather is beautiful today. I decided to go for a walk in the park. The birds are singing and the flowers are blooming.",
  "marian-en-es",
  { validation: "contains-any", contains: ["tiempo", "parque", "pájaros", "flores", "hermoso"] },
  20000,
);

export const marianEnEsShortText = createMarianTest(
  "translation-marian-en-es-short-text",
  "Thank you very much",
  "marian-en-es",
  { validation: "contains-any", contains: ["gracias", "muchas"] },
  10000,
);

export const marianEnEsSpecialChars = createMarianTest(
  "translation-marian-en-es-special-chars",
  "What's your name? I'm John!",
  "marian-en-es",
  { validation: "contains-any", contains: ["nombre", "cómo", "llam"] },
);

export const marianEnEsQuestion = createMarianTest(
  "translation-marian-en-es-question",
  "Can you tell me where the train station is?",
  "marian-en-es",
  { validation: "contains-any", contains: ["estación", "tren", "dónde", "decir"] },
);

export const marianEnEsStreaming = createMarianTest(
  "translation-marian-en-es-streaming",
  "Good morning, how are you?",
  "marian-en-es",
  { validation: "contains-any", contains: ["buenos", "días", "cómo"] },
);

// --- ES → EN (marian-es-en) ---

export const marianEsEnBasic = createMarianTest(
  "translation-marian-es-en-basic",
  "Hola, ¿cómo estás hoy?",
  "marian-es-en",
  { validation: "contains-any", contains: ["hello", "how", "are", "you", "today"] },
);

export const marianEsEnLongText = createMarianTest(
  "translation-marian-es-en-long-text",
  "El tiempo es hermoso hoy. Decidí ir a dar un paseo por el parque. Los pájaros cantan y las flores están floreciendo.",
  "marian-es-en",
  { validation: "contains-any", contains: ["weather", "park", "birds", "flowers", "beautiful"] },
  20000,
);

export const marianEsEnQuestion = createMarianTest(
  "translation-marian-es-en-question",
  "¿Puede decirme dónde está la estación de tren?",
  "marian-es-en",
  { validation: "contains-any", contains: ["station", "train", "where", "tell"] },
);

export const translationMarianTests = [
  // DE → EN
  marianDeEnBasic,
  marianDeEnLongText,
  marianDeEnShortText,
  marianDeEnSpecialChars,
  marianDeEnNumbers,
  marianDeEnQuestion,
  marianDeEnFormal,
  marianDeEnEmptyText,
  marianDeEnStreaming,
  marianDeEnStats,
  marianDeEnBatchBasic,
  marianDeEnBatchMultiple,
  // EN → ES
  marianEnEsBasic,
  marianEnEsLongText,
  marianEnEsShortText,
  marianEnEsSpecialChars,
  marianEnEsQuestion,
  marianEnEsStreaming,
  // ES → EN
  marianEsEnBasic,
  marianEsEnLongText,
  marianEsEnQuestion,
];
