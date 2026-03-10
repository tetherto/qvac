import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createNmtTest = (
  testId: string,
  text: string,
  expectation:
    | { validation: "contains-any"; contains: string[] }
    | { validation: "type"; expectedType: "string" },
  estimatedDurationMs: number = 15000,
): TestDefinition => ({
  testId,
  params: { text },
  expectation,
  metadata: { category: "nmt", dependency: "nmt", estimatedDurationMs },
});

export const nmtTranslationBasic = createNmtTest(
  "nmt-translation-basic",
  "Hallo, wie geht es dir heute?",
  { validation: "contains-any", contains: ["hello", "how", "are", "you", "today"] },
);

export const nmtTranslationLongText = createNmtTest(
  "nmt-translation-long-text",
  "Der schnelle braune Fuchs springt über den faulen Hund. Dieser Satz enthält viele häufige Buchstaben. Die maschinelle Übersetzung hat in den letzten Jahren große Fortschritte gemacht, wobei neuronale maschinelle Übersetzungsmodelle beeindruckende Ergebnisse erzielen.",
  { validation: "type", expectedType: "string" },
  20000,
);

export const nmtTranslationShortText = createNmtTest(
  "nmt-translation-short-text",
  "Ja",
  { validation: "type", expectedType: "string" },
  10000,
);

export const nmtTranslationRepeatedWords = createNmtTest(
  "nmt-translation-repeated-words",
  "Sehr sehr sehr wichtig. Extrem extrem extrem entscheidend. Absolut absolut absolut notwendig.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationSpecialChars = createNmtTest(
  "nmt-translation-special-chars",
  "Hallo! Wie geht's dir? Das kostet 50€ - nicht $60! Très bien, señor. Müller & Co.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationNumbers = createNmtTest(
  "nmt-translation-numbers",
  "Das Treffen ist um 10:30 Uhr. Wir haben 25 Teilnehmer. Die Raumnummer ist 302.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationPunctuation = createNmtTest(
  "nmt-translation-punctuation",
  "Warte... bist du sicher? Ja! Absolut; ohne Zweifel: 100%.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationEmptyText: TestDefinition = {
  testId: "nmt-translation-empty-text",
  params: { text: "" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "nmt", dependency: "nmt", estimatedDurationMs: 10000 },
};

export const nmtTranslationTechnical = createNmtTest(
  "nmt-translation-technical",
  "Die API-Schnittstelle ermöglicht HTTP-Anfragen mit JSON-Daten. Der Server antwortet mit einem Statuscode.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationFormal = createNmtTest(
  "nmt-translation-formal",
  "Sehr geehrte Damen und Herren, hiermit möchte ich mich für die Stelle bewerben. Mit freundlichen Grüßen.",
  { validation: "type", expectedType: "string" },
);

export const nmtTranslationQuestion = createNmtTest(
  "nmt-translation-question",
  "Können Sie mir bitte sagen, wo der Bahnhof ist? Wie weit ist es von hier?",
  { validation: "contains-any", contains: ["station", "where", "far"] },
);

export const nmtTranslationMaxlength = createNmtTest(
  "nmt-translation-maxlength",
  "Dies ist ein sehr langer Text, der die maximale Länge der Übersetzung testen soll. " +
    "Er enthält mehrere Sätze und verschiedene Themen. " +
    "Die maschinelle Übersetzung muss alle diese Sätze korrekt verarbeiten. " +
    "Wir testen hier auch die Qualität bei längeren Eingaben. " +
    "Der Text geht weiter und weiter, um sicherzustellen, dass alles funktioniert.",
  { validation: "type", expectedType: "string" },
  20000,
);

export const nmtBatchTranslationBasic: TestDefinition = {
  testId: "nmt-batch-translation-basic",
  params: { texts: ["Guten Morgen", "Gute Nacht"] },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "nmt", dependency: "nmt", estimatedDurationMs: 15000 },
};

export const nmtBatchTranslationMultiple: TestDefinition = {
  testId: "nmt-batch-translation-multiple",
  params: {
    texts: [
      "Wie geht es dir?",
      "Das Wetter ist schön.",
      "Ich habe Hunger.",
      "Auf Wiedersehen.",
      "Vielen Dank.",
    ],
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "nmt", dependency: "nmt", estimatedDurationMs: 25000 },
};

export const nmtTests = [
  nmtTranslationBasic,
  nmtTranslationLongText,
  nmtTranslationShortText,
  nmtTranslationRepeatedWords,
  nmtTranslationSpecialChars,
  nmtTranslationNumbers,
  nmtTranslationPunctuation,
  nmtTranslationEmptyText,
  nmtTranslationTechnical,
  nmtTranslationFormal,
  nmtTranslationQuestion,
  nmtTranslationMaxlength,
  nmtBatchTranslationBasic,
  nmtBatchTranslationMultiple,
];
