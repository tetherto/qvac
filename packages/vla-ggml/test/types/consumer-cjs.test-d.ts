// Type-level consumer test: CommonJS `import ... = require(...)` must see a
// construct signature. Type-checked only (via test:types) — never executed.

import VlaModel = require("../../index");

// The package's default export IS the constructor.
const model = new VlaModel({ files: { model: ["/abs/model.gguf"] } });

// The class name is usable as a type as well as a value.
const asType: VlaModel = model;
void asType;

// `options` is required: `new VlaModel()` compiles to a runtime
// MISSING_REQUIRED_PARAMETER throw, so it must be a compile error too.
// @ts-expect-error - VlaModelOptions is a required constructor argument
const missingOptions = new VlaModel();
void missingOptions;

// @ts-expect-error - files.model is required
const missingFiles = new VlaModel({});
void missingFiles;

// Public types are reachable through the namespace.
const hparams: VlaModel.VlaHparams = {
  chunkSize: 50,
  actionDim: 6,
  maxActionDim: 32,
  maxStateDim: 32,
  tokenizerMaxLength: 48,
  visionImageSize: 512,
};
void hparams;

const options: VlaModel.VlaModelOptions = {
  files: { model: ["/abs/model.gguf"] },
  opts: { stats: true },
};
void options;

const runInput: VlaModel.VlaRunInput = {
  images: [new Float32Array(3 * 512 * 512)],
  state: new Float32Array(32),
  tokens: new Int32Array(48),
  mask: new Uint8Array(48),
};
void runInput;

async function exerciseRun(): Promise<VlaModel.VlaRunResult> {
  await model.load({ backend: "cpu" });
  const response: VlaModel.QvacResponse = await model.run(runInput);
  const result: VlaModel.VlaRunResult = await response.await();
  const stats: VlaModel.VlaRunStats = result.stats;
  void stats;
  return result;
}
void exerciseRun;

// The attached CommonJS properties are typed, not `any`.
const size: number = VlaModel.DEFAULT_IMAGE_SIZE;
void size;
const padded: Float32Array = VlaModel.padState([1, 2, 3], 32);
void padded;
const plane: Float32Array = VlaModel.preprocessImage(
  new Float32Array(3 * 4 * 4),
  4,
  4,
);
void plane;
const errCode: number = VlaModel.ERR_CODES.MISSING_REQUIRED_PARAMETER;
void errCode;
const err: VlaModel.QvacErrorAddonVla = new VlaModel.QvacErrorAddonVla({
  code: VlaModel.ERR_CODES.INVALID_INPUT,
  adds: "nope",
});
void err;

// `module.exports.VlaModel === module.exports`: the self-referential property
// must stay constructable, since JS consumers destructure it.
const viaSelfRef = new VlaModel.VlaModel({
  files: { model: ["/abs/model.gguf"] },
});
void viaSelfRef;
