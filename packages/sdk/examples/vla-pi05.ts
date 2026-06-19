/**
 * π₀.₅ (pi05) vision-language-action example using the QVAC SDK.
 *
 * Loads the Physical Intelligence π₀.₅ GGUF model, runs a single inference
 * pass with synthetic inputs (zero-filled gray images + BOS-only tokens +
 * seeded noise), and prints the produced action chunk + per-stage timings.
 *
 * π₀.₅ differs from SmolVLA in two ways the SDK surfaces via `vlaHparams()`:
 *   - `numCameras: 3` — it expects exactly three camera frames (not two).
 *   - `stateInputMode: 'discrete'` — the robot state is tokenised into the
 *     language prompt, so the `state` buffer is ignored. We pass an empty
 *     `Float32Array(0)`. π₀.₅ also requires the `noise` prior.
 *
 * Usage:
 *   bun examples/vla-pi05.ts [path-to-pi05.gguf]
 *
 * By default the example pulls the registry-baked π₀.₅ GGUF (~3.9 GB) on
 * first run and caches it locally. Pass an absolute path on the command line
 * to override and load a local GGUF instead.
 */
import {
  close,
  loadModel,
  PI05_BASE_Q_AGGRESSIVE,
  unloadModel,
  vla,
  vlaHparams,
  vlaPreprocessImage,
} from "@qvac/sdk";

const modelSrcOverride = process.argv[2];
const modelSrc = modelSrcOverride ?? PI05_BASE_Q_AGGRESSIVE;

try {
  console.log("▸ Loading π₀.₅ (pi05) model...");
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
  // model's tokenizer, and (for π₀.₅) inline the robot state into the prompt.
  const size = hparams.visionImageSize;
  const numCameras = hparams.numCameras ?? 3;
  const dummyPixels = new Uint8Array(size * size * 3).fill(128);
  // π₀.₅ expects exactly `numCameras` frames.
  const images = Array.from({ length: numCameras }, () =>
    vlaPreprocessImage(dummyPixels, size, size, { size }),
  );

  const tokens = new Int32Array(hparams.tokenizerMaxLength);
  const mask = new Uint8Array(hparams.tokenizerMaxLength);
  // BOS-only "instruction" for the smoke test.
  tokens[0] = 1;
  mask[0] = 1;

  // Discrete-state model: the state buffer is ignored (state is tokenised
  // into the prompt), so pass an empty Float32Array. π₀.₅ requires `noise`.
  const state = new Float32Array(0);
  const noise = new Float32Array(hparams.chunkSize * hparams.maxActionDim);

  console.log("▸ Running VLA inference...");
  const { actions, actionDim, chunkSize, stats } = await vla({
    modelId,
    images,
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
        `prefill=${stats.prefill_total_ms?.toFixed(0)}ms ` +
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
