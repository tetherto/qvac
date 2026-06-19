/**
 * SmolVLA (vision-language-action) example using the QVAC SDK.
 *
 * Loads the SmolVLA-LIBERO GGUF model, runs a single inference pass with
 * synthetic inputs (zero-filled gray images + BOS-only tokens + zero state +
 * zero noise), and prints the produced action chunk + per-stage timings.
 *
 * Usage:
 *   bun examples/vla-smolvla.ts [path-to-smolvla.gguf]
 *
 * By default the example pulls the registry-baked SmolVLA-LIBERO GGUF
 * (~1.9 GB) on first run and caches it locally. Pass an absolute path on
 * the command line to override and load a local GGUF instead.
 */
import {
  close,
  loadModel,
  SMOLVLA_LIBERO_VISION_Q8,
  unloadModel,
  vla,
  vlaHparams,
  vlaPadState,
  vlaPreprocessImage,
} from "@qvac/sdk";

const modelSrcOverride = process.argv[2];
const modelSrc = modelSrcOverride ?? SMOLVLA_LIBERO_VISION_Q8;

try {
  console.log("▸ Loading SmolVLA model...");
  const modelId = await loadModel({
    modelSrc,
    modelType: "ggml-vla",
    modelConfig: { backend: "cpu" },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  if (typeof modelSrc !== "string") process.stderr.write("\n");
  console.log(`▸ Model loaded: ${modelId}`);

  const { hparams, backendName } = await vlaHparams({ modelId });
  console.log(`▸ Backend: ${backendName ?? "(unknown)"}`);
  console.log("▸ Hparams:", hparams);

  // Build synthetic inputs sized to the model's expectations. A real
  // consumer would: read camera frames, tokenize the instruction with the
  // SmolVLM2 tokenizer, and read the robot's current end-effector pose.
  const size = hparams.visionImageSize;
  const dummyPixels = new Uint8Array(size * size * 3).fill(128);
  const front = vlaPreprocessImage(dummyPixels, size, size, { size });
  const wrist = vlaPreprocessImage(dummyPixels, size, size, { size });

  const tokens = new Int32Array(hparams.tokenizerMaxLength);
  const mask = new Uint8Array(hparams.tokenizerMaxLength);
  // BOS-only "instruction" for the smoke test.
  tokens[0] = 1;
  mask[0] = 1;

  const state = vlaPadState([0, 0, 0, 0, 0, 0], hparams.maxStateDim);
  const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim);

  console.log("▸ Running VLA inference...");
  const { actions, actionDim, chunkSize, stats } = await vla({
    modelId,
    images: [front, wrist],
    imgWidth: size,
    imgHeight: size,
    state,
    tokens,
    mask,
    noise,
  });

  console.log(`▸ Got ${chunkSize} action steps of dim ${actionDim}.`);
  console.log(Array.from(actions.subarray(0, actionDim)));
  if (stats) {
    console.log(
      `▸ Timing: vision=${stats.vision_ms?.toFixed(0)}ms ` +
        `smollm2=${stats.smollm2_total_ms?.toFixed(0)}ms ` +
        `ode=${stats.ode_ms?.toFixed(0)}ms ` +
        `total=${stats.total_ms?.toFixed(0)}ms`,
    );
  }

  await unloadModel({ modelId, clearStorage: false });
  console.log("▸ Model unloaded.");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  await close();
  process.exit(1);
}
