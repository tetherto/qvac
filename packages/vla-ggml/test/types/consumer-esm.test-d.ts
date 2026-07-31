// Type-level consumer test: the SDK's named-import shape (ggml-vla plugin).
// `VlaModel` must resolve as both a value and a type; compiled with the SDK's
// module settings. Type-checked only — never executed.

import { VlaModel } from "../../index";
import type {
  VlaHparams,
  VlaModelOptions,
  VlaRunInput,
  VlaRunResult,
  VlaRunStats,
  QvacResponse,
} from "../../index";

interface VlaModelWrapper {
  load(force?: boolean): Promise<void>;
  unload?(): Promise<void>;
}

// Exactly the SDK plugin's wrapper signature.
function wrapVlaModel(inner: VlaModel): VlaModel & VlaModelWrapper {
  const wrapper = inner as VlaModel & VlaModelWrapper;
  const originalLoad = wrapper.load.bind(wrapper);
  wrapper.load = function load(): Promise<void> {
    return originalLoad({ backend: "cpu" });
  };
  return wrapper;
}

const options: VlaModelOptions = {
  files: { model: ["/abs/model.gguf"] },
  logger: null,
  opts: { stats: true },
};

const model = new VlaModel(options);
void wrapVlaModel(model);

// The SDK plugin's literal construction call, including the conditional spread
// (guards `exactOptionalPropertyTypes` compatibility of VlaModelOptions).
declare const modelPath: string;
declare const verbosity: number | undefined;
declare const streamLogger: {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
};
void new VlaModel({
  files: { model: [modelPath] },
  ...(verbosity !== undefined && { config: { verbosity } }),
  logger: streamLogger,
  opts: { stats: true },
});

// @ts-expect-error - VlaModelOptions is a required constructor argument
const missingOptions = new VlaModel();
void missingOptions;

const hparams: VlaHparams | null = model.hparams;
void hparams;

const runInput: VlaRunInput = {
  images: [new Float32Array(3 * 512 * 512)],
  state: new Float32Array(32),
  tokens: new Int32Array(48),
  mask: new Uint8Array(48),
};

async function exerciseRun(): Promise<VlaRunStats> {
  const response: QvacResponse = await model.run(runInput);
  const result: VlaRunResult = await response.await();
  return result.stats;
}
void exerciseRun;

// Named value exports carried on the CommonJS export object.
export {};
