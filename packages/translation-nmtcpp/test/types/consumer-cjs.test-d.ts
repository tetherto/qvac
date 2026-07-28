// Type-level consumer test: CommonJS `import ... = require(...)` shape.
//
// This is the shape a plain TypeScript CommonJS consumer uses. Before the
// `export =` rewrite, the trailing `module.exports = TranslationNmtcpp` was a
// bare statement invisible to the declaration emitter — the emitted `.d.ts`
// advertised `export default`, so this file failed with TS2351 ("This
// expression is not constructable").
//
// Compiled with `tsc --noEmit -p test/types/tsconfig.cjs.json` via
// `npm run test:types`. No runtime component — it must never be executed,
// only type-checked, because it does not load the native addon.

import TranslationNmtcpp = require("../../index");

// The package's export IS the constructor.
const model = new TranslationNmtcpp({
  files: { model: "/abs/model.bin" },
  params: { srcLang: "en", dstLang: "fr" },
  config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot },
});

// The class name is usable as a type as well as a value.
const asType: TranslationNmtcpp = model;
void asType;

// `args` is required — `new TranslationNmtcpp()` throws at runtime.
// @ts-expect-error - TranslationNmtcppArgs is a required constructor argument
const missingArgs = new TranslationNmtcpp();
void missingArgs;

// @ts-expect-error - files and params are required members of the argument
const missingFiles = new TranslationNmtcpp({});
void missingFiles;

// Public types are reachable through the namespace.
const files: TranslationNmtcpp.TranslationNmtcppFiles = {
  model: "/abs/model.bin",
  srcVocab: "/abs/vocab.src.spm",
  dstVocab: "/abs/vocab.dst.spm",
  pivotModel: "/abs/pivot.bin",
  pivotSrcVocab: "/abs/pivot.src.spm",
  pivotDstVocab: "/abs/pivot.dst.spm",
};
void files;

const params: TranslationNmtcpp.TranslationNmtcppParams = {
  srcLang: "en",
  dstLang: "fr",
};
void params;

const config: TranslationNmtcpp.TranslationNmtcppConfig = {
  modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
  use_gpu: true,
  gpu_backend: "vulkan",
  gpu_device: 0,
  backendsDir: "/abs/prebuilds",
  openclCacheDir: "/abs/cache",
};
void config;

const args: TranslationNmtcpp.TranslationNmtcppArgs = {
  files,
  params,
  config,
  opts: { stats: true },
};
void args;

const modelTypes: TranslationNmtcpp.TranslationNmtcppModelTypes =
  TranslationNmtcpp.ModelTypes;
void modelTypes;

const state: TranslationNmtcpp.InferenceClientState = model.getState();
void state;

const stats: TranslationNmtcpp.RuntimeStats = {
  totalTokens: 12,
  totalTime: 0.5,
  decodeTime: 0.3,
  TPS: 24,
  encodeTime: 0.2,
  TTFT: 40,
};
void stats;

// Instance surface.
async function exercise(): Promise<string[]> {
  await model.load();
  const response = await model.run("hello");
  const out: string[] = [];
  for await (const chunk of response.iterate()) out.push(chunk);
  void model.getActiveBackendName();
  void model.getActiveBackendDescription();
  const batch: string[] = await model.runBatch(["a", "b"]);
  await model.unload();
  await model.destroy();
  return [...out, ...batch];
}
void exercise;
