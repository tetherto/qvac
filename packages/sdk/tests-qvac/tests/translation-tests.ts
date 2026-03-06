// Translation test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

const createTranslationTest = (
  testId: string,
  text: string,
  sourceLang: string,
  targetLang: string,
  expectedKeywords: string[],
): TestDefinition => ({
  testId,
  params: { text, sourceLang, targetLang },
  expectation: { validation: "contains-any", contains: expectedKeywords },
  metadata: {
    category: "translation",
    dependency: "llm",
    estimatedDurationMs: 10000,
  },
});

export const translationEnToEs = createTranslationTest(
  "translation-en-to-es",
  "Hello, how are you?",
  "en",
  "es",
  ["hola", "cómo", "estás"],
);

export const translationEsToEn = createTranslationTest(
  "translation-es-to-en",
  "Hola, ¿cómo estás?",
  "es",
  "en",
  ["hello", "how", "are"],
);

export const translationEnToFr = createTranslationTest(
  "translation-en-to-fr",
  "Hello, how are you today?",
  "en",
  "fr",
  ["bonjour", "comment", "allez", "vous"],
);

export const translationDeToFr = createTranslationTest(
  "translation-de-to-fr",
  "Guten Tag, wie geht es Ihnen?",
  "de",
  "fr",
  ["bonjour", "comment", "allez"],
);

export const translationItToFr = createTranslationTest(
  "translation-it-to-fr",
  "Buongiorno, come stai?",
  "it",
  "fr",
  ["bonjour", "comment", "vas"],
);

export const translationEsToFr = createTranslationTest(
  "translation-es-to-fr",
  "Hola, ¿cómo estás?",
  "es",
  "fr",
  ["bonjour", "comment", "vas"],
);

export const translationFrToEs = createTranslationTest(
  "translation-fr-to-es",
  "Bonjour, comment allez-vous?",
  "fr",
  "es",
  ["hola", "cómo", "está"],
);

export const translationFrToDe = createTranslationTest(
  "translation-fr-to-de",
  "Bonjour, comment allez-vous?",
  "fr",
  "de",
  ["guten", "wie", "geht", "hallo", "bonjour"],
);

export const translationFrToEn = createTranslationTest(
  "translation-fr-to-en",
  "Bonjour, comment allez-vous aujourd'hui?",
  "fr",
  "en",
  ["hello", "how", "are", "you", "today", "bonjour"],
);

export const translationEnToPt = createTranslationTest(
  "translation-en-to-pt",
  "Hello, how are you today?",
  "en",
  "pt",
  ["olá", "como", "está"],
);

export const translationError: TestDefinition = {
  testId: "translation-error",
  params: { text: " ", sourceLang: "en", targetLang: "invalid" }, // SDK rejects empty with Zod
  expectation: { validation: "type", expectedType: "string" }, // Should handle gracefully
  metadata: {
    category: "translation",
    dependency: "llm",
    estimatedDurationMs: 5000,
  },
};

export const translationTests = [
  translationEnToEs,
  translationEsToEn,
  translationEnToFr,
  translationDeToFr,
  translationItToFr,
  translationEsToFr,
  translationFrToEs,
  translationFrToDe,
  translationFrToEn,
  translationEnToPt,
  translationError,
];
