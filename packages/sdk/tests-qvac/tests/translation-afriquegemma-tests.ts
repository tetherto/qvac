import type { TestDefinition, Expectation } from "@tetherto/qvac-test-suite";

const createAfriquegemmaTest = (
  testId: string,
  text: string,
  to: string,
  expectation: Expectation,
  opts: { from?: string; estimatedDurationMs?: number } = {},
  suites?: string[],
): TestDefinition => ({
  testId,
  params: {
    text,
    to,
    resource: "afriquegemma",
    ...(opts.from && { from: opts.from }),
  },
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: "translation-afriquegemma",
    dependency: "afriquegemma",
    estimatedDurationMs: opts.estimatedDurationMs ?? 300000,
  },
});

export const afriquegemmaEnSw = createAfriquegemmaTest(
  "translation-afriquegemma-en-sw",
  "Hello, how are you today?",
  "sw",
  { validation: "type", expectedType: "string" },
  { from: "en", estimatedDurationMs: 300000 },
);

export const afriquegemmSwEn = createAfriquegemmaTest(
  "translation-afriquegemma-sw-en",
  "Habari yako leo?",
  "en",
  { validation: "contains-any", contains: ["hello", "how", "are", "you", "today", "news"] },
  { from: "sw" },
  ["smoke"],
);

export const afriquegemmaStreaming: TestDefinition = {
  testId: "translation-afriquegemma-streaming",
  params: { text: "Hello, how are you today?", from: "en", to: "sw", resource: "afriquegemma" },
  expectation: { validation: "type", expectedType: "string" },
  metadata: { category: "translation-afriquegemma", dependency: "afriquegemma", estimatedDurationMs: 120000 },
};

export const translationAfriquegemmaTests = [
  afriquegemmaEnSw,
  afriquegemmSwEn,
  afriquegemmaStreaming,
];
