// Type-level consumer test: CommonJS `import ... = require(...)` must see a
// construct signature. Type-checked only (via test:types) — never executed.

import LlmLlamacpp = require("../../index");

// The package's export IS the constructor.
const model = new LlmLlamacpp({
  files: { model: ["/abs/model.gguf"] },
  config: { device: "gpu", ctx_size: "4096" },
});

// The class name is usable as a type as well as a value.
const asType: LlmLlamacpp = model;
void asType;

// `args` is required — `new LlmLlamacpp()` throws at runtime.
// @ts-expect-error - LlmLlamacppArgs is a required constructor argument
const missingArgs = new LlmLlamacpp();
void missingArgs;

// @ts-expect-error - files and config are required members of the argument
const missingFiles = new LlmLlamacpp({});
void missingFiles;

// Statics attached to `module.exports` are typed.
const primary: string = LlmLlamacpp.pickPrimaryGgufPath([
  "/abs/model-00001-of-00002.gguf",
  "/abs/model-00002-of-00002.gguf",
]);
void primary;

// `QvacResponse` is attached at runtime for bundled mobile tests but is
// deliberately absent from the type surface — `typeof QvacResponse` cannot be
// named by a consumer that does not depend on `@qvac/infer-base` directly.
// @ts-expect-error - not part of the published constructor surface
void LlmLlamacpp.QvacResponse;

// Public instance surface.
const addon: LlmLlamacpp.Addon | null = model.addon;
void addon;
const logger = model.logger;
void logger;
const state: { configLoaded: boolean } = model.getState();
void state;

// Public types are reachable through the namespace.
const config: LlmLlamacpp.LlamaConfig = {
  device: "gpu",
  parallel: 4,
  "split-mode": "layer",
};
void config;

const generationParams: LlmLlamacpp.GenerationParams = {
  temp: 0.7,
  json_schema: { type: "object" },
  remove_thinking_from_context: true,
};
void generationParams;

const runOptions: LlmLlamacpp.RunOptions = {
  prefill: false,
  generationParams,
  cacheKey: "k",
  saveCacheToDisk: true,
  rejectWhenBusy: true,
};
void runOptions;

const messages: LlmLlamacpp.Message[] = [
  { role: "user", content: "hello" },
  { role: "user", type: "media", content: new Uint8Array([1, 2, 3]) },
  { type: "function", name: "get_weather", parameters: { type: "object" } },
];
void messages;

const batch: LlmLlamacpp.BatchPrompt[] = [{ id: "a", prompt: messages, runOptions }];
void batch;

const finetuneOptions: LlmLlamacpp.FinetuneOptions = {
  trainDatasetDir: "/abs/train.jsonl",
  validation: { type: "split", fraction: 0.1 },
  outputParametersDir: "/abs/out",
};
void finetuneOptions;

const validations: LlmLlamacpp.FinetuneValidation[] = [
  { type: "none" },
  { type: "split", fraction: 0.05 },
  { type: "dataset", path: "/abs/eval.jsonl" },
];
void validations;

// Overload resolution: a single prompt yields QvacResponse, a batch yields BatchResponse.
async function overloads() {
  const single: LlmLlamacpp.QvacResponse = await model.run(messages, runOptions);
  void single;
  const batched: LlmLlamacpp.BatchResponse = await model.run(batch);
  const ids: string[] = batched.ids;
  void ids;
  const results: LlmLlamacpp.BatchResult[] = await batched.await();
  void results;
  batched.onUpdate((chunk: LlmLlamacpp.BatchOutputChunk) => {
    void chunk.id;
    void chunk.chunk;
  });
  const handle: LlmLlamacpp.FinetuneHandle = await model.finetune(finetuneOptions);
  handle.on("stats", (stats: LlmLlamacpp.FinetuneProgressStats) => {
    void stats.global_steps;
  });
  const finetuneResult: LlmLlamacpp.FinetuneResult = await handle.await();
  void finetuneResult;
  await model.load();
  await model.cancel();
  await model.pause();
  await model.unload();
}
void overloads;

// Addon-boundary types stay reachable from the package root.
const runJobMessages: LlmLlamacpp.AddonRunJobMessage[] = [
  { type: "text", input: "{}", prefill: false },
  { type: "media", content: new Uint8Array() },
];
void runJobMessages;
const admission: LlmLlamacpp.AdmissionResult = { accepted: true, id: 1 };
void admission;
const batchItem: LlmLlamacpp.AddonBatchRunItem = { id: "x", messages: runJobMessages };
void batchItem;
const batchAdmission: LlmLlamacpp.AddonBatchRunResult = { accepted: false, ids: ["x"] };
void batchAdmission;
const stats: LlmLlamacpp.RuntimeStats = {
  TTFT: 1,
  TPS: 2,
  ppTPS: 3,
  CacheTokens: 4,
  generatedTokens: 5,
  promptTokens: 6,
  contextSlides: 0,
  thinkingBlockDiscards: 0,
  avgConcurrentSeq: 1,
  backendDevice: "gpu",
  stopReason: "eos",
};
void stats;
const numericLike: LlmLlamacpp.NumericLike = "42";
void numericLike;
