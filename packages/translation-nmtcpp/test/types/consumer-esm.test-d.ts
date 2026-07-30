// Type-level consumer test: the SDK's default-import shape (nmtcpp-translation
// plugin), compiled with the SDK's module settings. Type-checked only — never
// executed.

import TranslationNmtcpp, {
  type TranslationNmtcppConfig,
  type TranslationNmtcppFiles,
} from "../../index";
// The SDK's addonLogging import shape; named bindings must resolve too.
import nmtAddonLogging, {
  setLogger,
  releaseLogger,
  type AddonLogging,
} from "../../addonLogging";
import type {
  TranslationNmtcppArgs,
  TranslationNmtcppParams,
  InferenceClientState,
  RuntimeStats,
} from "../../index";

declare const modelPath: string;
declare const srcVocabPath: string | undefined;
declare const dstVocabPath: string | undefined;
declare const engine: "Bergamot" | "IndicTrans";
declare const from: string;
declare const to: string;
declare const mode: string;
declare const streamLogger: {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};

// The SDK plugin's literal construction path, conditional spreads included, so
// `exactOptionalPropertyTypes` regressions surface here rather than in the SDK.
const files: TranslationNmtcppFiles = {
  model: modelPath,
  ...(srcVocabPath && { srcVocab: srcVocabPath }),
  ...(dstVocabPath && { dstVocab: dstVocabPath }),
};

const config: TranslationNmtcppConfig = {
  // Static class member reached through the default import, keyed by a union.
  modelType: TranslationNmtcpp.ModelTypes[engine],
  temperature: 0.7,
};

const model = new TranslationNmtcpp({
  files,
  params: { mode, srcLang: from, dstLang: to },
  config,
  logger: streamLogger,
  opts: { stats: true },
});

// The default import carries the class TYPE as well as the value.
function wrap(inner: TranslationNmtcpp): TranslationNmtcpp {
  return inner;
}
void wrap(model);

// @ts-expect-error - TranslationNmtcppArgs is a required constructor argument
const missingArgs = new TranslationNmtcpp();
void missingArgs;

// Named type imports resolve through the namespace.
const args: TranslationNmtcppArgs = { files, params: { srcLang: from, dstLang: to } };
void args;
const params: TranslationNmtcppParams = { srcLang: from, dstLang: to };
void params;
const state: InferenceClientState = model.getState();
void state;
declare const stats: RuntimeStats;
void stats.TPS;

// The published instance type must stay structural (see the CJS consumer test
// for the full rationale) — a mock with the public surface is assignable.
declare const fakeResponse: ReturnType<TranslationNmtcpp["run"]>;
const mock: TranslationNmtcpp = {
  getState: () => ({ configLoaded: true, weightsLoaded: true, destroyed: false }),
  load: () => Promise.resolve(),
  run: () => fakeResponse,
  runBatch: (texts: string[]) => Promise.resolve(texts),
  unload: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
  getActiveBackendName: () => "Vulkan0",
  getActiveBackendDescription: () => "NVIDIA GeForce RTX 5070",
};
void mock;

// addonLogging: default import (SDK shape) and named bindings.
const logging: AddonLogging = nmtAddonLogging;
void logging;
nmtAddonLogging.setLogger((priority: number, message: string) => {
  void priority;
  void message;
});
nmtAddonLogging.releaseLogger();

setLogger((priority: number, message: string) => {
  void priority;
  void message;
});
releaseLogger();

export {};
