// Real SDK tests
import type { TestDefinition } from "@tetherto/qvac-test-suite";
import { completionTests } from "./completion-tests.js";
import { transcriptionTests } from "./transcription-tests.js";
import { embeddingTests } from "./embedding-tests.js";
import { ragTests } from "./rag-tests.js";
import { translationIndicTransTests } from "./translation-indictrans-tests.js";
import { translationBergamotTests } from "./translation-bergamot-tests.js";
import { translationLlmTests } from "./translation-llm-tests.js";
import { translationSalamandraTests } from "./translation-salamandra-tests.js";
import { translationAfriquegemmaTests } from "./translation-afriquegemma-tests.js";
import { modelInfoTests } from "./model-info-tests.js";
import { kvCacheTests } from "./kv-cache-tests.js";
import { errorTests } from "./error-tests.js";
import { toolsTests } from "./tools-tests.js";
import { ocrTests } from "./ocr-tests.js";
import { ttsTests } from "./tts-tests.js";
import { configReloadTests } from "./config-reload-tests.js";
import { loggingTests } from "./logging-tests.js";
import { registryTests } from "./registry-tests.js";
import { shardedModelTests } from "./sharded-model-tests.js";
import { httpEmbeddingTests } from "./http-embedding-tests.js";
import { parakeetTests } from "./parakeet-tests.js";
import { visionTests } from "./vision-tests.js";
import { downloadTests } from "./download-tests.js";
import { delegatedInferenceTests } from "./delegated-inference-tests.js";
import { diffusionTests } from "./diffusion-tests.js";
import { finetuneTests } from "./finetune-tests.js";
import { lifecycleTests } from "./lifecycle-tests.js";
import { configTests } from "./config-tests.js";

// Model loading tests
export const modelLoadLlm: TestDefinition = {
  testId: "model-load-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadEmbedding: TestDefinition = {
  testId: "model-load-embedding",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 60000,
  },
};

export const modelLoadOcr: TestDefinition = {
  testId: "model-load-ocr",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 90000,
  },
};

export const modelLoadInvalid: TestDefinition = {
  testId: "model-load-invalid",
  params: {
    modelType: "llm",
    modelPath: "/invalid/path/nonexistent-model.gguf",
  },
  expectation: {
    validation: "throws-error",
    errorContains: "failed to locate",
  },
  suites: ["smoke"],
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 5000,
  },
};

export const modelUnload: TestDefinition = {
  testId: "model-unload",
  params: { shouldClearStorage: false },
  expectation: { validation: "type", expectedType: "string" },
  suites: ["smoke"],
  metadata: { category: "model", dependency: "llm", estimatedDurationMs: 5000 },
};

export const modelLoadConcurrent: TestDefinition = {
  testId: "model-load-concurrent",
  params: {
    models: [
      { type: "llm", constant: "LLAMA_3_2_1B_INST_Q4_0" },
      { type: "embeddings", constant: "GTE_LARGE_FP16" },
    ],
  },
  expectation: { validation: "type", expectedType: "array" },
  suites: ["smoke"],
  metadata: {
    category: "model",
    dependency: "none",
    estimatedDurationMs: 120000,
    expectedCount: 2,
  },
};

export const modelReloadLlm: TestDefinition = {
  testId: "model-reload-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 15000,
  },
};

export const modelSwitchLlm: TestDefinition = {
  testId: "model-switch-llm",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 90000,
  },
};

export const modelReloadAfterError: TestDefinition = {
  testId: "model-reload-after-error",
  params: {},
  expectation: { validation: "type", expectedType: "string" },
  metadata: {
    category: "model",
    dependency: "llm",
    estimatedDurationMs: 70000,
  },
};


// Export all tests as array
export const tests = [
  // Model tests (first section)
  modelLoadLlm,
  modelLoadEmbedding,
  modelLoadOcr,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,

  // Parakeet transcription tests
  ...parakeetTests,

  // Completion tests
  ...completionTests,

  // Transcription tests
  ...transcriptionTests,

  // Embedding tests
  ...embeddingTests,

  // RAG tests
  ...ragTests,

  // Translation: IndicTrans2 (EN↔HI)
  ...translationIndicTransTests,

  // Translation: Bergamot (EN→FR, EN→ES)
  ...translationBergamotTests,

  // Translation: LLM (open-vocabulary via from/to)
  ...translationLlmTests,

  // Translation: Salamandra (EU languages)
  ...translationSalamandraTests,

  // Translation: AfriqueGemma (African languages)
  ...translationAfriquegemmaTests,

  // Sharded model tests
  ...shardedModelTests,

  // HTTP embedding tests
  ...httpEmbeddingTests,

  // Model info tests
  ...modelInfoTests,

  // KV cache tests
  ...kvCacheTests,

  // Error tests
  ...errorTests,

  // Tools tests
  ...toolsTests,

  // OCR tests
  ...ocrTests,

  // TTS tests
  ...ttsTests,

  // Config reload tests
  ...configReloadTests,

  // Logging tests
  ...loggingTests,

  // Registry tests
  ...registryTests,

  // Vision tests
  ...visionTests,

  // Download tests (cancel isolation)
  ...downloadTests,

  // Diffusion tests
  ...diffusionTests,

  // Delegated inference tests (P2P)
  ...delegatedInferenceTests,

  // Finetuning tests
  ...finetuneTests,

  // Lifecycle tests (suspend/resume)
  ...lifecycleTests,

  // Registry-download config tests (retries + stream timeout)
  ...configTests,

  // Additional model tests
  modelSwitchLlm,
  modelReloadAfterError,
];
