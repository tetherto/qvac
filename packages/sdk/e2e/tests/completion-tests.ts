// Completion test definitions
import type { TestDefinition } from "@tetherto/qvac-test-suite";

interface GenerationParams {
  temp?: number;
  top_p?: number;
  top_k?: number;
  predict?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repeat_penalty?: number;
  reasoning_budget?: -1 | 0;
}

type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        description?: string;
        strict?: boolean;
      };
    };

// Shared deterministic sampling: greedy decode + fixed seed so a passing
// assertion stays reproducible across runs, models, and addon updates.
const DETERMINISTIC: GenerationParams = { temp: 0, seed: 42 };

interface CompletionTestParams {
  history: Array<{ role: string; content: string }>;
  stream?: boolean;
  stopSequences?: string[];
  responseFormat?: ResponseFormat;
  tools?: Array<Record<string, unknown>>;
  generationParams?: GenerationParams;
}

type CompletionExpectation =
  | { validation: "contains-all" | "contains-any"; contains: string[] }
  | { validation: "regex"; pattern: string }
  | { validation: "type"; expectedType: "string" | "number" | "array" }
  | { validation: "throws-error"; errorContains: string };

interface CompletionTestOptions {
  estimatedDurationMs?: number;
  suites?: string[];
  skip?: { reason: string };
  dependency?: "llm" | "none";
}

// Helper for creating completion tests with common structure
const createCompletionTest = (
  testId: string,
  params: CompletionTestParams,
  expectation: CompletionExpectation,
  options: CompletionTestOptions = {},
): TestDefinition => ({
  testId,
  params,
  expectation,
  ...(options.suites && { suites: options.suites }),
  ...(options.skip && { skip: options.skip }),
  metadata: {
    category: "completion",
    dependency: options.dependency ?? "llm",
    estimatedDurationMs: options.estimatedDurationMs ?? 10000,
  },
});

// Basic completion tests
export const completionStreaming = createCompletionTest(
  "completion-streaming",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with only the number." },
    ],
    stream: true,
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["4"] },
  { suites: ["smoke"] },
);

export const completionEmptyPrompt = createCompletionTest(
  "completion-empty-prompt",
  {
    history: [{ role: "user", content: "" }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 5000, suites: ["smoke"] },
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
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["42"] },
  { suites: ["smoke"] },
);

// Temperature variations
export const completionTemperature00 = createCompletionTest(
  "completion-temperature-00",
  {
    history: [
      { role: "user", content: "What is 5+5? Answer with just the number." },
    ],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["10"] },
  { estimatedDurationMs: 8000, suites: ["smoke"] },
);

export const completionTemperature05 = createCompletionTest(
  "completion-temperature-05",
  {
    history: [
      { role: "user", content: "What is 6+6? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.5, seed: 42 },
  },
  { validation: "contains-all", contains: ["12"] },
  { estimatedDurationMs: 8000 },
);

// High-temperature sweep: the point is that the sampling param is accepted and
// generation still works — not exact arithmetic (brittle at temp >= 1.0).
export const completionTemperature10 = createCompletionTest(
  "completion-temperature-10",
  {
    history: [
      { role: "user", content: "What is 7+7? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 1.0, seed: 42 },
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 8000 },
);

export const completionTemperature15 = createCompletionTest(
  "completion-temperature-15",
  {
    history: [
      { role: "user", content: "What is 8+8? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 1.5, seed: 42 },
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 8000 },
);

// top_p variations
export const completionTopP = createCompletionTest(
  "completion-top-p",
  {
    history: [
      { role: "user", content: "What is 7 + 8? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.1, top_p: 0.1, seed: 42 },
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
    generationParams: { temp: 0.1, top_p: 0.1, seed: 42 },
  },
  { validation: "contains-all", contains: ["1", "2", "3", "4", "5"] },
  { estimatedDurationMs: 8000, suites: ["smoke"] },
);

export const completionTopP05 = createCompletionTest(
  "completion-top-p-05",
  {
    history: [
      { role: "user", content: "What is 9+9? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.1, top_p: 0.5, seed: 42 },
  },
  { validation: "contains-all", contains: ["18"] },
  { estimatedDurationMs: 8000 },
);

export const completionTopP10 = createCompletionTest(
  "completion-top-p-10",
  {
    history: [
      { role: "user", content: "What is 11+11? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.1, top_p: 1.0, seed: 42 },
  },
  { validation: "contains-all", contains: ["22"] },
  { estimatedDurationMs: 8000 },
);

// Frequency penalty variations
export const completionFrequencyPenalty00 = createCompletionTest(
  "completion-frequency-penalty-00",
  {
    history: [
      { role: "user", content: "What is 15+15? Answer with just the number." },
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: 0.0 },
  },
  { validation: "contains-all", contains: ["30"] },
  { estimatedDurationMs: 8000 },
);

export const completionFrequencyPenaltyNeg10 = createCompletionTest(
  "completion-frequency-penalty-neg10",
  {
    history: [
      { role: "user", content: "What is 13+13? Answer with just the number." },
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: -1.0 },
  },
  { validation: "contains-all", contains: ["26"] },
  { estimatedDurationMs: 8000 },
);

export const completionFrequencyPenalty10 = createCompletionTest(
  "completion-frequency-penalty-10",
  {
    history: [
      { role: "user", content: "What is 17+17? Answer with just the number." },
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, frequency_penalty: 1.0 },
  },
  { validation: "contains-all", contains: ["34"] },
  { estimatedDurationMs: 8000 },
);

export const completionPresencePenalty = createCompletionTest(
  "completion-presence-penalty",
  {
    history: [
      { role: "user", content: "What is 14+14? Answer with just the number." },
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, presence_penalty: 1.0 },
  },
  { validation: "contains-all", contains: ["28"] },
  { estimatedDurationMs: 8000 },
);

// Temperature variations (already have 0.0, 0.5, 1.0, 1.5)
export const completionTemperature01 = createCompletionTest(
  "completion-temperature-01",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.1, seed: 42 },
  },
  { validation: "contains-all", contains: ["4"] },
  { estimatedDurationMs: 8000 },
);

export const completionTemperature09 = createCompletionTest(
  "completion-temperature-09",
  {
    history: [
      { role: "user", content: "What is 2+2? Answer with just the number." },
    ],
    stream: false,
    generationParams: { temp: 0.9, seed: 42 },
  },
  { validation: "contains-all", contains: ["4"] },
  { estimatedDurationMs: 8000 },
);

// Advanced parameters
export const completionStopSequences = createCompletionTest(
  "completion-stop-sequences",
  {
    history: [{ role: "user", content: "Repeat exactly the following words separated by spaces: apple banana cherry" }],
    stream: false,
    stopSequences: ["banana"],
  },
  { validation: "contains-all", contains: ["apple", "banana"] }, // Should stop at banana
);

export const completionRepeatPenalty = createCompletionTest(
  "completion-repeat-penalty",
  {
    history: [{ role: "user", content: "Count from 1 to 5. Answer with just the numbers separated by spaces." }],
    stream: false,
    generationParams: { ...DETERMINISTIC, repeat_penalty: 1.3 },
  },
  { validation: "contains-all", contains: ["1", "2", "3", "4", "5"] },
  { estimatedDurationMs: 8000 },
);

export const completionTopK = createCompletionTest(
  "completion-top-k",
  {
    history: [
      { role: "user", content: "What is 2 + 3? Answer with just the number." },
    ],
    stream: false,
    generationParams: { ...DETERMINISTIC, top_k: 1 },
  },
  { validation: "contains-all", contains: ["5"] },
  { estimatedDurationMs: 8000 },
);

// Runs the same prompt twice with a fixed seed and asserts byte-identical
// output — see CompletionExecutor.seedReproducibility.
export const completionSeedReproducibility = createCompletionTest(
  "completion-seed-reproducibility",
  {
    history: [
      { role: "user", content: "Generate a random story in 20 words." },
    ],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
);

export const completionStopSequencesMultiple = createCompletionTest(
  "completion-stop-sequences-multiple",
  {
    history: [{ role: "user", content: "List 20 animals, one per line." }],
    stream: false,
    stopSequences: ["dog", "cat", "bird"],
  },
  { validation: "type", expectedType: "string" },
);

export const completionMaxTokens = createCompletionTest(
  "completion-max-tokens",
  {
    history: [{ role: "user", content: "Count from 1 to 100." }],
    stream: false,
    generationParams: { ...DETERMINISTIC, predict: 10 },
  },
  { validation: "type", expectedType: "string" },
);

// Fires multiple completions in parallel and asserts all resolve correctly —
// see CompletionExecutor.concurrentRequests.
export const completionConcurrentRequests = createCompletionTest(
  "completion-concurrent-requests",
  {
    history: [{ role: "user", content: "What is 3 + 3? Answer with just the number." }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["6"] },
  { estimatedDurationMs: 15000, suites: ["smoke"] },
);

export const completionCountInWords = createCompletionTest(
  "completion-count-in-words",
  {
    history: [{ role: "user", content: "Count from one to five using words." }],
    stream: false,
    generationParams: DETERMINISTIC,
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
    generationParams: DETERMINISTIC,
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
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["25", "{", "}"] },
  { suites: ["smoke"] },
);

export const completionCodeGeneration = createCompletionTest(
  "completion-code-generation",
  {
    history: [
      { role: "user", content: "Write a hello world function in JavaScript." },
    ],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-any", contains: ["function", "hello", "console"] },
);

export const completionConversationContext = createCompletionTest(
  "completion-conversation-context",
  {
    history: [{ role: "user", content: "Tell me about AI." }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
);

export const completionSingleWord = createCompletionTest(
  "completion-single-word",
  {
    history: [{ role: "user", content: "Hello" }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
);

export const completionListGeneration = createCompletionTest(
  "completion-list-generation",
  {
    history: [{ role: "user", content: "List 5 colors." }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
);

export const completionQaFromContext = createCompletionTest(
  "completion-qa-from-context",
  {
    history: [
      { role: "user", content: "The sky is blue. What color is the sky?" },
    ],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "contains-all", contains: ["blue"] },
  { suites: ["smoke"] },
);

export const completionSentenceCompletion = createCompletionTest(
  "completion-sentence-completion",
  {
    history: [{ role: "user", content: "The quick brown fox" }],
    stream: false,
    generationParams: DETERMINISTIC,
  },
  { validation: "type", expectedType: "string" },
);

export const completionResponseFormatText = createCompletionTest(
  "completion-response-format-text",
  {
    history: [{ role: "user", content: "Reply with only the word BANANA." }],
    stream: false,
    responseFormat: { type: "text" },
    generationParams: { ...DETERMINISTIC, predict: 16 },
  },
  { validation: "type", expectedType: "string" },
);

export const completionResponseFormatJsonObject = createCompletionTest(
  "completion-response-format-json-object",
  {
    history: [
      { role: "system", content: "Reply with a single valid JSON object only. No markdown, no prose." },
      { role: "user", content: "Return an object with a single key 'ok' set to the boolean true." },
    ],
    stream: false,
    responseFormat: { type: "json_object" },
    generationParams: { ...DETERMINISTIC, predict: 64 },
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 15000 },
);

export const completionResponseFormatJsonObjectStreaming = createCompletionTest(
  "completion-response-format-json-object-streaming",
  {
    history: [
      { role: "system", content: "Reply with a single valid JSON object only. No markdown, no prose." },
      { role: "user", content: "Return an object with a single key 'ok' set to the boolean true." },
    ],
    stream: true,
    responseFormat: { type: "json_object" },
    generationParams: { ...DETERMINISTIC, predict: 64 },
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 15000 },
);

export const completionResponseFormatJsonSchema = createCompletionTest(
  "completion-response-format-json-schema",
  {
    history: [
      {
        role: "user",
        content:
          "Extract the person info as JSON. Person: Alice, age 30, occupation data engineer.",
      },
    ],
    stream: false,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "Person",
        schema: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
            occupation: { type: "string" },
          },
          required: ["name", "age", "occupation"],
          additionalProperties: false,
        },
      },
    },
    generationParams: { ...DETERMINISTIC, predict: 128 },
  },
  { validation: "type", expectedType: "string" },
  { estimatedDurationMs: 20000 },
);

export const completionReasoningBudgetDisabled = createCompletionTest(
  "completion-reasoning-budget-disabled",
  {
    history: [{ role: "user", content: "What is 2+2? Answer with only the number." }],
    stream: false,
    generationParams: { reasoning_budget: 0, predict: 32 },
  },
  { validation: "type", expectedType: "string" },
);

export const completionReasoningBudgetUnrestricted = createCompletionTest(
  "completion-reasoning-budget-unrestricted",
  {
    history: [{ role: "user", content: "What is 2+2? Answer with only the number." }],
    stream: false,
    generationParams: { reasoning_budget: -1, predict: 32 },
  },
  { validation: "type", expectedType: "string" },
);

export const completionResponseFormatWithToolsRejected = createCompletionTest(
  "completion-response-format-with-tools-rejected",
  {
    history: [{ role: "user", content: "irrelevant" }],
    stream: false,
    responseFormat: { type: "json_object" },
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    generationParams: { ...DETERMINISTIC, predict: 64 },
  },
  { validation: "throws-error", errorContains: "responseFormat" },
  { estimatedDurationMs: 5000, dependency: "none" },
);

export const completionTests = [
  completionStreaming,
  completionTemperature01,
  completionTemperature09,
  completionEmptyPrompt,
  completionMultiTurn,
  completionMaxTokens,
  completionStopSequences,
  completionTopP,
  completionRepeatPenalty,
  completionTopK,
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
  completionPresencePenalty,
  completionSeedReproducibility,
  completionStopSequencesMultiple,
  completionConcurrentRequests,
  completionCountInWords,
  completionWithWhitespace,
  completionJsonFormat,
  completionCodeGeneration,
  completionConversationContext,
  completionSingleWord,
  completionListGeneration,
  completionQaFromContext,
  completionSentenceCompletion,
  completionResponseFormatText,
  completionResponseFormatJsonObject,
  completionResponseFormatJsonObjectStreaming,
  completionResponseFormatJsonSchema,
  completionResponseFormatWithToolsRejected,
  completionReasoningBudgetDisabled,
  completionReasoningBudgetUnrestricted,
];
