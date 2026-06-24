# 🔌 API Changes v0.12.0

## Expose diffusion_fa, drop flux_flow, sync model registry

PR: [#2046](https://github.com/tetherto/qvac/pull/2046)

```typescript
diffusion_fa?: boolean  // enable per-transformer flash attention (addon default: true as of @qvac/diffusion-cpp@0.8.0)
```

```
GEMMA4_31B_MULTIMODAL_Q4_K_M
GEMMA4_31B_MULTIMODAL_Q6_K
MMPROJ_GEMMA4_31B_MULTIMODAL_BF16
MMPROJ_GEMMA4_31B_MULTIMODAL_F16
GEMMA4_2B_MULTIMODAL_Q4_K_M
GEMMA4_2B_MULTIMODAL_Q6_K
MMPROJ_GEMMA4_2B_MULTIMODAL_BF16
MMPROJ_GEMMA4_2B_MULTIMODAL_F16
GEMMA4_4B_MULTIMODAL_Q4_K_M
GEMMA4_4B_MULTIMODAL_Q6_K
MMPROJ_GEMMA4_4B_MULTIMODAL_BF16
MMPROJ_GEMMA4_4B_MULTIMODAL_F16
BERGAMOT_METADATA
BERGAMOT_EN_BS_LEX
BERGAMOT_METADATA_1
BERGAMOT_EN_BS
BERGAMOT_EN_BS_VOCAB
BERGAMOT_METADATA_2
BERGAMOT_EN_NB_LEX
BERGAMOT_METADATA_3
BERGAMOT_EN_NB
BERGAMOT_EN_NB_VOCAB
BERGAMOT_METADATA_4
BERGAMOT_EN_NO_LEX
BERGAMOT_METADATA_5
BERGAMOT_EN_NO
BERGAMOT_EN_NO_VOCAB
BERGAMOT_EN_SR_LEX
BERGAMOT_METADATA_6
BERGAMOT_EN_SR
BERGAMOT_EN_SR_VOCAB
BERGAMOT_EN_TH_LEX
BERGAMOT_METADATA_7
BERGAMOT_EN_TH
BERGAMOT_EN_TH_VOCAB
BERGAMOT_EN_VI_LEX
BERGAMOT_METADATA_8
BERGAMOT_EN_VI
BERGAMOT_EN_VI_VOCAB
BERGAMOT_EN_ZH_LEX
BERGAMOT_METADATA_9
BERGAMOT_EN_ZH
BERGAMOT_EN_ZH_SRCVOCAB
BERGAMOT_EN_ZH_TRGVOCAB
BERGAMOT_LEX
BERGAMOT_METADATA_10
BERGAMOT
BERGAMOT_VOCAB
BERGAMOT_NO_EN_LEX
BERGAMOT_METADATA_11
BERGAMOT_NO_EN
BERGAMOT_NO_EN_VOCAB
BERGAMOT_TH_EN_LEX
BERGAMOT_METADATA_12
BERGAMOT_TH_EN
BERGAMOT_TH_EN_VOCAB
BERGAMOT_ZH_EN_LEX
BERGAMOT_ZH_EN
BERGAMOT_ZH_EN_VOCAB
PARAKEET_TDT_PARAKEET_CTC_0_6B_Q8_0_Q8_0
PARAKEET_TDT_PARAKEET_EOU_120M_V1_Q8_0_Q8_0
PARAKEET_TDT_PARAKEET_TDT_0_6B_V3_Q8_0_Q8_0
PARAKEET_TDT_Q8_0
QWEN3_5_0_8B_MULTIMODAL_Q4_K_M
QWEN3_5_0_8B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_5_0_8B_MULTIMODAL_BF16
MMPROJ_QWEN3_5_0_8B_MULTIMODAL_F16
QWEN3_5_2B_MULTIMODAL_Q4_K_M
QWEN3_5_2B_MULTIMODAL_Q6_K
MMPROJ_QWEN3_5_2B_MULTIMODAL_BF16
MMPROJ_QWEN3_5_2B_MULTIMODAL_F16
QWEN3_5_4B_MULTIMODAL_Q4_K_M
QWEN3_5_4B_MULTIMODAL_Q6_K
MMPROJ_QWEN3_5_4B_MULTIMODAL_BF16
MMPROJ_QWEN3_5_4B_MULTIMODAL_F16
QWEN3_5_9B_MULTIMODAL_Q4_K_M
QWEN3_5_9B_MULTIMODAL_Q6_K
MMPROJ_QWEN3_5_9B_MULTIMODAL_BF16
MMPROJ_QWEN3_5_9B_MULTIMODAL_F16
QWEN3_6_27B_MULTIMODAL_Q4_K_XL
QWEN3_6_27B_MULTIMODAL_Q6_K_XL
MMPROJ_QWEN3_6_27B_MULTIMODAL_BF16
MMPROJ_QWEN3_6_27B_MULTIMODAL_F16
QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M
QWEN3_6_35B_A3B_MULTIMODAL_Q6_K_XL
MMPROJ_QWEN3_6_35B_A3B_MULTIMODAL_BF16
MMPROJ_QWEN3_6_35B_A3B_MULTIMODAL_F16
```

```
BERGAMOT_EN_BG_LEX
BERGAMOT_EN_BG
BERGAMOT_EN_BG_VOCAB
BERGAMOT_EN_HR_LEX
BERGAMOT_EN_HR
BERGAMOT_EN_HR_VOCAB
BERGAMOT_EN_NL_LEX
BERGAMOT_EN_NL
BERGAMOT_EN_NL_VOCAB
BERGAMOT_METADATA_13
```

---

## Resolve SDK from hoisted node_modules in expo plugins

PR: [#2139](https://github.com/tetherto/qvac/pull/2139)

```typescript
import { resolveSDKPackageDir } from "@qvac/sdk/expo-plugin";

// Before: only checked <projectRoot>/node_modules/@qvac/sdk
// After:  walks up from <projectRoot> through every ancestor node_modules.
//         Closest match to projectRoot wins; shadowed copies trigger a console.warn.
const { name, dir } = resolveSDKPackageDir(projectRoot);
//      ^^^^  ^^^
//      "@qvac/sdk"  "/path/to/.../node_modules/@qvac/sdk"
```

```typescript
import {
  getProjectRootFromMod,
  getProjectRootFromBaseConfig,
} from "@qvac/sdk/expo-plugin";

// In a mod plugin (callback passed to withDangerousMod etc.):
function buildMobileBundle(config: ExportedConfigWithProps<unknown>) {
  const projectRoot = getProjectRootFromMod(config);
  // ...
}

// In a base plugin (called with the bare ExpoConfig):
function withDeviceInfo(config: ExpoConfig) {
  const projectRoot = getProjectRootFromBaseConfig(config);
  if (!projectRoot) return config;
  // ...
}
```

---

## Integrate SmolVLA addon into SDK

PR: [#2190](https://github.com/tetherto/qvac/pull/2190)

```typescript
  import {
    loadModel,
    unloadModel,
    vla,
    vlaHparams,
    vlaPreprocessImage,
    vlaPadState,
    VLA_DEFAULT_IMAGE_SIZE,
    SMOLVLA_LIBERO_VISION_Q8,
    type VlaConfig,
    type VlaClientRunParams,
    type VlaClientRunResult,
    type VlaHparams,
    type VlaStats,
    PLUGIN_VLA,
  } from "@qvac/sdk";
  
  // Pull SmolVLA-LIBERO from the registry (cached on first run).
  const modelId = await loadModel({
    modelSrc: SMOLVLA_LIBERO_VISION_Q8,
    modelType: "vla",                // or "ggml-vla"
    modelConfig: { backend: "auto" }, // "auto" | "cpu"
    onProgress: (p) => console.log(`Downloading: ${p.percentage.toFixed(1)}%`),
  });
  
  // Inspect the loaded model's hparams + ggml backend name.
  const { hparams, backendName } = await vlaHparams({ modelId });

  // Build inference inputs.
  const size = hparams.visionImageSize;
  const front = vlaPreprocessImage(frontPixels, frontW, frontH, { size });
  const wrist = vlaPreprocessImage(wristPixels, wristW, wristH, { size });
  const state = vlaPadState(robotState, hparams.maxStateDim);
  // ...tokenize the instruction into `tokens` / `mask` with the SmolVLM2 tokenizer...

  // Run one inference pass.
  const { actions, actionDim, chunkSize, stats } = await vla({
    modelId, images: [front, wrist], imgWidth: size, imgHeight: size,
    state, tokens, mask,
  });
  
  await unloadModel({ modelId, clearStorage: false });

  See packages/sdk/examples/vla-smolvla.ts for the full demo (now defaults to the registry constant; pass a local GGUF path as argv[2] to override).
  ```

---

## Integrate @qvac/classification-ggml into SDK

PR: [#2236](https://github.com/tetherto/qvac/pull/2236)

```typescript
import {
  loadModel,
  unloadModel,
  classify,
  PLUGIN_CLASSIFICATION,
  type ClassifyClientParams,
  type ClassificationResult,
} from "@qvac/sdk";

// Load with bundled MobileNetV3-Small — no `modelSrc` needed.
const modelId = await loadModel({
  modelType: "classification",          // alias for "ggml-classification"
  modelConfig: { topK: 3 },             // optional load-time default
});

// Or load a custom GGUF classifier.
const customId = await loadModel({
  modelType: "classification",
  modelSrc: "/abs/path/to/my-classifier.gguf",
});

// Classify a JPEG/PNG buffer.
const jpeg = fs.readFileSync("photo.jpg");
const results = await classify({ modelId, image: jpeg });
// → [ { label: "food", confidence: 0.91 }, { label: "other", confidence: 0.05 }, ... ]

// Per-call `topK` overrides the load-time default.
const topOne = await classify({ modelId, image: jpeg, topK: 1 });

// Raw RGB bytes (skip JPEG/PNG decode).
const raw = await classify({
  modelId,
  image: rgbBytes,
  width: 224,
  height: 224,
  channels: 3,
});

await unloadModel({ modelId, clearStorage: false });
```

---

## Add text-to-video support with WAN models to the SDK

PR: [#2243](https://github.com/tetherto/qvac/pull/2243)

```typescript
import { video, type VideoClientParams } from "@qvac/sdk";

const run = video({
  modelId,
  mode: "txt2vid",
  prompt: "a cat surfing a wave at sunset",
  width: 480,
  height: 832,
  video_frames: 17,
  fps: 16,
  steps: 20,
} satisfies VideoClientParams);

for await (const tick of run.progressStream) {
  console.log(`step ${tick.step}/${tick.totalSteps} (${tick.elapsedMs}ms)`);
}

const frames = await run.outputs;
const stats = await run.stats;
```

---

## Add @qvac/sdk/commands subpath

PR: [#2253](https://github.com/tetherto/qvac/pull/2253)

```
=== bundle with plugins config ===
bundle: .../packages/sdk/qvac/worker.bundle.js
plugins: @qvac/sdk/llamacpp-completion/plugin, @qvac/sdk/nmtcpp-translation/plugin
verify: ok
PASS: bundle with plugins config

=== bundle with no plugins field (default-all fallback) ===
plugins count: 8
PASS: bundle with no plugins field (default-all fallback)

=== invalid plugins entry throws InvalidPluginSpecifierError ===
got InvalidPluginSpecifierError: Invalid plugin specifiers (must end with /plugin):
  - not-a-valid-plugin
PASS: invalid plugins entry throws InvalidPluginSpecifierError
```

```typescript
import { bundleSdk, verifyBundle } from "@qvac/sdk/commands";

await bundleSdk({
  projectRoot: process.cwd(),
  configPath: "./qvac.config.json",
  quiet: true,
});

const result = await verifyBundle({
  projectRoot: process.cwd(),
  addonsSource: "./qvac/worker.bundle.js",
  hosts: ["android-arm64", "ios-arm64"],
});
```

---

## Forward device + expose backendDevice for standalone ESRGAN upscaler

PR: [#2274](https://github.com/tetherto/qvac/pull/2274)

```typescript
import { loadModel, upscale, REALESRGAN_X4PLUS_ANIME_6B } from "@qvac/sdk";

const modelId = await loadModel(REALESRGAN_X4PLUS_ANIME_6B, {
  modelType: "diffusion",
  modelConfig: {
    mode: "upscale",
    device: "gpu", // now actually forwarded to the standalone ESRGAN upscaler
    upscaler: { tile_size: 128 },
  },
});
const { outputs, stats } = upscale({ modelId, image: pngBytes });
const [upscaledPng] = await outputs;
const upscaleStats = await stats;

// NEW: inspect the device the backend actually ran on
console.log(upscaleStats?.backendDevice); // "cpu" | "gpu" | undefined
```

---

## Export RAG_ERROR_CODES from SDK for cancellation detection

PR: [#2291](https://github.com/tetherto/qvac/pull/2291)

```typescript
import { RAG_ERROR_CODES } from "@qvac/sdk";

if (err.code === RAG_ERROR_CODES.OPERATION_CANCELLED) {
  // RAG ingest was cancelled
}
```

---

## Surface promptTokens and ContextOverflowError on completion

PR: [#2330](https://github.com/tetherto/qvac/pull/2330)

```typescript
import { ContextOverflowError } from "@qvac/sdk";

const run = sdk.completion({ /* ... */ });
try {
  const final = await run.final;
  console.log(final.stats?.promptTokens); // new: real input count
} catch (err) {
  if (err instanceof ContextOverflowError) {
    console.warn(
      `prompt of ${err.promptTokens} tokens exceeded ${err.ctxSize}`,
    );
    // typed across the RPC boundary — works inside Bare workers too.
  }
}
```

```bash
  # In qvac-workbench:
  bun install
  # Patch applies; ContextOverflowError + promptTokens visible in
  # node_modules/@qvac/sdk/dist/.

  bun run --cwd cli src/index.ts serve --port 11591 --name qvac-19591
  # Loaded Qwen3.5-9B-Q4_K_M, server up on http://127.0.0.1:11591.

  curl -sS http://127.0.0.1:11591/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"any","messages":[{"role":"user","content":"Hello! Who are you?"}],"stream":false}'
  # usage: { prompt_tokens: 1191, completion_tokens: 17, total_tokens: 1208 }
  ```

---

