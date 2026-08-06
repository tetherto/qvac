// Declaration-emit consumer test: every exported binding here is UNANNOTATED,
// so its type must be nameable through this package alone. A type that can
// only be named via `@qvac/infer-base` fails with TS2742 (and an unexported
// interface behind `export =` fails with TS4023). Compiled with
// `declaration: true` — `noEmit` fixtures cannot catch either.

import LlmLlamacpp from "@qvac/llm-llamacpp";
import llmAddonLogging from "@qvac/llm-llamacpp/addonLogging";

declare const model: LlmLlamacpp;

export function runOnce(text: string) {
  return model.run([{ role: "user", content: text }]);
}

export function runBatched(texts: string[]) {
  return model.run(texts.map((t) => ({ prompt: [{ role: "user", content: t }] })));
}

export function finetune(options: LlmLlamacpp.FinetuneOptions) {
  return model.finetune(options);
}

export function readAddon() {
  return model.addon;
}

export function readState() {
  return model.getState();
}

export function makeModel(modelPath: string) {
  return new LlmLlamacpp({ files: { model: [modelPath] }, config: { device: "gpu" } });
}

export const pickPrimary = LlmLlamacpp.pickPrimaryGgufPath;

export const logging = llmAddonLogging;
