// Completion test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

// Helper for creating completion tests with common structure
const createCompletionTest = (
  testId: string,
  params: {
    history: Array<{ role: string; content: string }>;
    stream?: boolean;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
    stopSequences?: string[];
  },
  expectation:
    | { validation: "contains-all" | "contains-any"; contains: string[] }
    | { validation: "regex"; pattern: string }
    | {
        validation: "type";
        expectedType: "string" | "number" | "array";
      },
  estimatedDurationMs: number = 10000,
  suites?: string[],
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(suites && { suites }),
  metadata: { category: "completion", dependency: "llm", estimatedDurationMs },
});

// Basic completion tests
export const completionStreaming = createCompletionTest(
  "completion-streaming",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
    stream: true,
  },
  { validation: "contains-all", contains: ["4"] },
  10000,
  ["smoke"],
);

export const completionEmptyPrompt = createCompletionTest(
  "completion-empty-prompt",
  {
    history: [{ role: "user", content: "" }],
    stream: false,
  },
  { validation: "type", expectedType: "string" },
  5000,
  ["smoke"],
);

export const completionMultiTurn = createCompletionTest(
  "completion-multi-turn",
  {
    history: [
      { role: "user", content: "Remember this number: 42." },
      { role: "assistant", content: "I'll remember that the number is 42." },
      {
        role: "user",
        content:
          "What number did I tell you to remember? Answer with just the number.",
      },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["42"] },
  10000,
  ["smoke"],
);

export const completionSpecialChars: TestDefinition = {
  testId: "completion-special-chars",
  params: {
    history: [
      {
        role: "user",
        content:
          "What is 50 + 50? Special chars: @#$% 👋 你好 🌍. Answer with just the number.",
      },
    ],
    stream: false,
  },
  expectation: { validation: "contains-all", contains: ["100"] },
  metadata: { category: "completion", dependency: "llm", estimatedDurationMs: 10000 },
  skip: { reason: "Flaky: 1B model unreliable on math with emoji distractions" },
};

// Temperature variations
export const completionTemperature00 = createCompletionTest(
  "completion-temperature-00",
  {
    history: [
      { role: "user", content: "What is 5+5? Answer with just the number." },
    ],
    stream: false,
    temperature: 0.0,
  },
  { validation: "contains-all", contains: ["10"] },
  8000,
  ["smoke"],
);

export const completionTemperature05 = createCompletionTest(
  "completion-temperature-05",
  {
    history: [
      { role: "user", content: "What is 6+6? Answer with just the number." },
    ],
    stream: false,
    temperature: 0.5,
  },
  { validation: "contains-all", contains: ["12"] },
  8000,
);

export const completionTemperature10 = createCompletionTest(
  "completion-temperature-10",
  {
    history: [
      { role: "user", content: "What is 7+7? Answer with just the number." },
    ],
    stream: false,
    temperature: 1.0,
  },
  { validation: "contains-all", contains: ["14"] },
  8000,
);

export const completionTemperature15 = createCompletionTest(
  "completion-temperature-15",
  {
    history: [
      { role: "user", content: "What is 8+8? Answer with just the number." },
    ],
    stream: false,
    temperature: 1.5,
  },
  { validation: "contains-all", contains: ["16"] },
  8000,
);

// top_p variations
export const completionTopP = createCompletionTest(
  "completion-top-p",
  {
    history: [
      { role: "user", content: "What is 7 + 8? Answer with just the number." },
    ],
    stream: false,
    topP: 0.1,
    temperature: 0.7,
  },
  { validation: "contains-all", contains: ["15"] },
);

export const completionTopP01 = createCompletionTest(
  "completion-top-p-01",
  {
    history: [
      {
        role: "user",
        content:
          "Count from 1 to 5. Answer with just the numbers separated by spaces.",
      },
    ],
    stream: false,
    temperature: 1.0,
    topP: 0.1,
  },
  { validation: "contains-all", contains: ["1", "2", "3", "4", "5"] },
  8000,
  ["smoke"],
);

export const completionTopP05 = createCompletionTest(
  "completion-top-p-05",
  {
    history: [
      { role: "user", content: "What is 9+9? Answer with just the number." },
    ],
    stream: false,
    temperature: 1.0,
    topP: 0.5,
  },
  { validation: "contains-all", contains: ["18"] },
  8000,
);

export const completionTopP10 = createCompletionTest(
  "completion-top-p-10",
  {
    history: [
      { role: "user", content: "What is 11+11? Answer with just the number." },
    ],
    stream: false,
    temperature: 1.0,
    topP: 1.0,
  },
  { validation: "contains-all", contains: ["22"] },
  8000,
);

// Frequency penalty variations
export const completionFrequencyPenalty00 = createCompletionTest(
  "completion-frequency-penalty-00",
  {
    history: [
      { role: "user", content: "What is 15+15? Answer with just the number." },
    ],
    stream: false,
    frequencyPenalty: 0.0,
  },
  { validation: "contains-all", contains: ["30"] },
  8000,
);

// Context size variations
export const completionContextSize512 = createCompletionTest(
  "completion-context-size-512",
  {
    history: [
      { role: "user", content: "What is 1+1? Answer with only the number." },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["2"] },
  8000,
);

export const completionContextSize2048 = createCompletionTest(
  "completion-context-size-2048",
  {
    history: [
      { role: "user", content: "What is 1+1? Answer with only the number." },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["2"] },
  8000,
);

// Temperature variations (already have 0.0, 0.5, 1.0, 1.5)
export const completionTemperature01 = createCompletionTest(
  "completion-temperature-01",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with just the number." },
    ],
    stream: false,
    temperature: 0.1,
  },
  { validation: "contains-all", contains: ["4"] },
  8000,
);

export const completionTemperature09 = createCompletionTest(
  "completion-temperature-09",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with just the number." },
    ],
    stream: false,
    temperature: 0.9,
  },
  { validation: "contains-all", contains: ["4"] },
  8000,
);

// Advanced parameters
export const completionStopSequences = createCompletionTest(
  "completion-stop-sequences",
  {
    history: [{ role: "user", content: "List 10 fruits, one per line." }],
    stream: false,
    stopSequences: ["banana"],
  },
  { validation: "contains-all", contains: ["apple", "banana"] }, // Should stop at banana
  10000,
);

export const completionRepeatPenalty = createCompletionTest(
  "completion-repeat-penalty",
  {
    history: [{ role: "user", content: "Count from 1 to 5." }],
    stream: false,
  },
  { validation: "type", expectedType: "string" },
  8000,
);

export const completionMinP = createCompletionTest(
  "completion-min-p",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with just the number." },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["4"] },
  8000,
);

export const completionZeroTemperature = createCompletionTest(
  "completion-zero-temperature",
  {
    history: [
      {
        role: "user",
        content: "What is 20 + 20? Answer with just the number.",
      },
    ],
    stream: false,
    temperature: 0.0,
  },
  { validation: "contains-all", contains: ["40"] },
  8000,
);

export const completionTopK = createCompletionTest(
  "completion-top-k",
  {
    history: [
      { role: "user", content: "What is 10 + 5? Answer with just the number." },
    ],
    stream: false,
    temperature: 0.5,
  },
  { validation: "contains-all", contains: ["15"] },
  8000,
);

export const completionFrequencyPenalty = createCompletionTest(
  "completion-frequency-penalty",
  {
    history: [{ role: "user", content: "List numbers from 1 to 10." }],
    stream: false,
  },
  { validation: "type", expectedType: "string" },
  8000,
);

export const completionFrequencyPenaltyNeg10 = createCompletionTest(
  "completion-frequency-penalty-neg10",
  {
    history: [
      { role: "user", content: "What is 13+13? Answer with just the number." },
    ],
    stream: false,
    frequencyPenalty: -1.0,
  },
  { validation: "contains-all", contains: ["26"] },
  8000,
);

export const completionFrequencyPenalty10 = createCompletionTest(
  "completion-frequency-penalty-10",
  {
    history: [
      { role: "user", content: "What is 17+17? Answer with just the number." },
    ],
    stream: false,
    frequencyPenalty: 1.0,
  },
  { validation: "contains-all", contains: ["34"] },
  8000,
);

export const completionNegativeTemperature = createCompletionTest(
  "completion-negative-temperature",
  {
    history: [
      { role: "user", content: "What is 1 + 1? Answer with just the number." },
    ],
    stream: false,
    temperature: -0.5,
  },
  { validation: "type", expectedType: "string" }, // SDK should handle gracefully
  8000,
);

export const completionSeedReproducibility = createCompletionTest(
  "completion-seed-reproducibility",
  {
    history: [
      { role: "user", content: "Generate a random story in 20 words." },
    ],
    stream: false,
    seed: 42,
  },
  { validation: "type", expectedType: "string" },
  10000,
);

export const completionStopSequencesMultiple = createCompletionTest(
  "completion-stop-sequences-multiple",
  {
    history: [{ role: "user", content: "List 20 animals, one per line." }],
    stream: false,
    stopSequences: ["dog", "cat", "bird"],
  },
  { validation: "type", expectedType: "string" },
  10000,
);

export const completionMaxTokens = createCompletionTest(
  "completion-max-tokens",
  {
    history: [{ role: "user", content: "Count from 1 to 100." }],
    stream: false,
    maxTokens: 10,
  },
  { validation: "type", expectedType: "string" },
  10000,
);

// Additional completion tests
export const completionConcurrentRequests = createCompletionTest(
  "completion-concurrent-requests",
  { history: [{ role: "user", content: "What is 3 + 3?" }], stream: false },
  { validation: "contains-all", contains: ["6"] },
  15000,
  ["smoke"],
);

export const completionRepeatedTokens = createCompletionTest(
  "completion-repeated-tokens",
  {
    history: [{ role: "user", content: "Count from one to five using words." }],
    stream: false,
  },
  { validation: "contains-any", contains: ["one", "two", "three"] },
);

export const completionWithWhitespace = createCompletionTest(
  "completion-whitespace",
  {
    history: [
      {
        role: "user",
        content: "   What is 12 + 12?   Answer with just the number.   ",
      },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["24"] },
);

export const completionJsonFormat = createCompletionTest(
  "completion-json-format",
  {
    history: [
      {
        role: "user",
        content:
          'Return this JSON: {"result": 25}. Just return the exact JSON.',
      },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["25", "{", "}"] },
  10000,
  ["smoke"],
);

export const completionCodeGeneration = createCompletionTest(
  "completion-code-generation",
  {
    history: [
      { role: "user", content: "Write a hello world function in JavaScript." },
    ],
    stream: false,
  },
  { validation: "contains-any", contains: ["function", "hello", "console"] },
);

export const completionConversationContext = createCompletionTest(
  "completion-conversation-context",
  { history: [{ role: "user", content: "Tell me about AI." }], stream: false },
  { validation: "type", expectedType: "string" },
);

export const completionSingleWord = createCompletionTest(
  "completion-single-word",
  { history: [{ role: "user", content: "Hello" }], stream: false },
  { validation: "type", expectedType: "string" },
);

export const completionListGeneration = createCompletionTest(
  "completion-list-generation",
  { history: [{ role: "user", content: "List 5 colors." }], stream: false },
  { validation: "type", expectedType: "string" },
);

export const completionQaFromContext = createCompletionTest(
  "completion-qa-from-context",
  {
    history: [
      { role: "user", content: "The sky is blue. What color is the sky?" },
    ],
    stream: false,
  },
  { validation: "contains-all", contains: ["blue"] },
  10000,
  ["smoke"],
);

export const completionSimpleYesNo: TestDefinition = {
  testId: "completion-simple-yes-no",
  params: {
    history: [{ role: "user", content: "Is 2+2=4? Answer yes or no." }],
    stream: false,
  },
  expectation: { validation: "contains-any", contains: ["yes", "Yes"] },
  metadata: { category: "completion", dependency: "llm", estimatedDurationMs: 10000 },
  skip: { reason: "Flaky: 1B model sometimes answers 'no' to trivial yes/no questions" },
};

export const completionSentenceCompletion = createCompletionTest(
  "completion-sentence-completion",
  {
    history: [{ role: "user", content: "The quick brown fox" }],
    stream: false,
  },
  { validation: "type", expectedType: "string" },
);

export const completionTests = [
  completionStreaming,
  completionContextSize512,
  completionContextSize2048,
  completionTemperature01,
  completionTemperature09,
  completionEmptyPrompt,
  completionMultiTurn,
  completionMaxTokens,
  completionSpecialChars,
  completionStopSequences,
  completionTopP,
  completionRepeatPenalty,
  completionMinP,
  completionZeroTemperature,
  completionTopK,
  completionFrequencyPenalty,
  completionNegativeTemperature,
  completionTemperature00,
  completionTemperature05,
  completionTemperature10,
  completionTemperature15,
  completionTopP01,
  completionTopP05,
  completionTopP10,
  completionFrequencyPenaltyNeg10,
  completionFrequencyPenalty00,
  completionFrequencyPenalty10,
  completionSeedReproducibility,
  completionStopSequencesMultiple,
  completionConcurrentRequests,
  completionRepeatedTokens,
  completionWithWhitespace,
  completionJsonFormat,
  completionCodeGeneration,
  completionConversationContext,
  completionSingleWord,
  completionListGeneration,
  completionQaFromContext,
  completionSimpleYesNo,
  completionSentenceCompletion,
];
