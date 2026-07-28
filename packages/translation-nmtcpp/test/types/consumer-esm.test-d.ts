// Type-level consumer test: ES-module DEFAULT-import shape.
//
// Mirrors how packages/sdk consumes this addon
// (`packages/sdk/server/bare/plugins/nmtcpp-translation/plugin.ts`):
//
//   import TranslationNmtcpp, {
//     type TranslationNmtcppConfig,
//     type TranslationNmtcppFiles
//   } from '@qvac/translation-nmtcpp'
//
// Under `export =` the default import relies on esModuleInterop's synthetic
// default, and the named type imports resolve through the namespace. Compiled
// with the SDK's own module settings (ES2022 + bundler resolution +
// verbatimModuleSyntax + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
// so a regression here is caught in this package's CI rather than in the SDK.

import TranslationNmtcpp, {
  type TranslationNmtcppConfig,
  type TranslationNmtcppFiles,
} from "../../index";
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

export {};
