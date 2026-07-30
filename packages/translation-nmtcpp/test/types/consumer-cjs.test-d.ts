// Type-level consumer test: CommonJS `import ... = require(...)` must see a
// construct signature. Type-checked only (via test:types) — never executed.

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

// The published instance type must stay STRUCTURAL: a public-surface mock must
// be assignable (leaked private fields would make the type nominal).
declare const fakeResponse: ReturnType<TranslationNmtcpp["run"]>;

const mock: TranslationNmtcpp = {
  getState: () => ({
    configLoaded: true,
    weightsLoaded: true,
    destroyed: false,
  }),
  load: () => Promise.resolve(),
  run: () => fakeResponse,
  runBatch: (texts: string[]) => Promise.resolve(texts),
  unload: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
  getActiveBackendName: () => "CPU",
  getActiveBackendDescription: () => "",
};
void mock;

// A mock MISSING a public member must still be rejected — otherwise the type
// has gone structurally empty rather than merely non-nominal.
// @ts-expect-error - runBatch/getActiveBackendName/getActiveBackendDescription missing
const incompleteMock: TranslationNmtcpp = {
  getState: () => ({
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false,
  }),
  load: () => Promise.resolve(),
  run: () => fakeResponse,
  unload: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
};
void incompleteMock;

// The real instance is of course still assignable to the structural type.
const realAsStructural: TranslationNmtcpp = model;
void realAsStructural;

// --------------------------------------------------------------------------
// `./addonLogging` subpath, CommonJS shape.
// --------------------------------------------------------------------------
import addonLogging = require("../../addonLogging");

addonLogging.setLogger((priority: number, message: string) => {
  void priority;
  void message;
});
addonLogging.releaseLogger();

const loggingSurface: addonLogging.AddonLogging = addonLogging;
void loggingSurface;
