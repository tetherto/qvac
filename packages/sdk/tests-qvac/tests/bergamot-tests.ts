import type { TestDefinition } from "@tetherto/qvac-test-suite";

export const bergamotTranslationBasic: TestDefinition = {
  testId: "bergamot-translation-basic",
  params: { text: "Hello, how are you today?" },
  expectation: { validation: "contains-any", contains: ["bonjour", "comment", "vous", "aujourd"] },
  metadata: { category: "bergamot", dependency: "bergamot", estimatedDurationMs: 15000 },
};

export const bergamotTranslationLongText: TestDefinition = {
  testId: "bergamot-translation-long-text",
  params: {
    text: "The weather is beautiful today. I decided to go for a walk in the park. " +
      "The birds are singing and the flowers are blooming. " +
      "It's a perfect day to enjoy nature and relax.",
  },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "bergamot", dependency: "bergamot", estimatedDurationMs: 20000 },
};

export const bergamotTranslationSpecialChars: TestDefinition = {
  testId: "bergamot-translation-special-chars",
  params: { text: "What's your name? I'm John! Nice to meet you..." },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "bergamot", dependency: "bergamot", estimatedDurationMs: 15000 },
};

export const bergamotTests = [
  bergamotTranslationBasic,
  bergamotTranslationLongText,
  bergamotTranslationSpecialChars,
];
