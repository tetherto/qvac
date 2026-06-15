# QVAC SDK v0.13.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.13.0

QVAC SDK 0.13.0 broadens the SDK across video, neural-signal transcription, robot-action models, and desktop packaging while tightening runtime behavior for local-first applications. This release also improves error reporting, completion metadata, transcription backend stats, mobile compatibility, and dependency shape for consumers that install only the integrations they need.

## Video Generation Adds Image-to-Video

The video API now supports image-to-video generation for Wan image-to-video pipelines. Consumers can provide an initial frame through `init_image` and control denoising with `strength`, making it possible to animate a source image instead of generating entirely from text.

```typescript
import fs from "node:fs";
import { video } from "@qvac/sdk";

const firstFrame = fs.readFileSync("portrait.png");
const { outputs } = video({
  modelId,
  mode: "img2vid",
  prompt: "the subject slowly turns and smiles, cinematic lighting",
  init_image: firstFrame,
  strength: 0.85,
});

const buffers = await outputs;
fs.writeFileSync("output.avi", buffers[0]);
```

This change also moves video dimension validation to the SDK schema boundary. Width and height now need to be multiples of 16, so invalid dimensions fail before they reach the native addon.

**Before:**

```typescript
video({ modelId, mode: "txt2vid", prompt: "...", width: 520, height: 264 });
```

**After:**

```typescript
video({ modelId, mode: "txt2vid", prompt: "...", width: 528, height: 272 });
```

## Worker Failures Are Now Typed SDK Errors

Bare worker crashes and SDK shutdown now surface as structured RPC errors instead of ambiguous failures. Applications can distinguish an unexpected worker death from an in-flight request that was cancelled because the SDK is closing.

```typescript
import { WorkerCrashedError, WorkerShutdownError } from "@qvac/sdk";

try {
  await sdk.embed({ modelId, text: "hi" });
} catch (err) {
  if (err instanceof WorkerCrashedError) {
    console.error(err.exitCode, err.exitSignal);
  } else if (err instanceof WorkerShutdownError) {
    console.error("The SDK closed while this request was in flight.");
  }
}
```

## Electron Apps Can Tree-Shake Native Addons

The new Electron Forge plugin helps packaged desktop apps include only the native addon trees needed by their QVAC configuration. This reduces accidental bundling of unused prebuilds and keeps app packages closer to the target platform set.

```typescript
const QvacForgePlugin = require("@qvac/sdk/electron-forge");

module.exports = {
  packagerConfig: { name: "MyApp" },
  plugins: [
    new QvacForgePlugin({
      configPath: "./qvac.config.json",
      hosts: ["darwin-arm64", "darwin-x64"],
      logLevel: "info",
    }),
  ],
};
```

## Completion and Transcription Metadata Are More Precise

Completion final results now report `stopReason: "length"` when generation stops because the token budget was exhausted, and `stopReason: "cancelled"` when a request is cancelled. Natural end-of-sequence completions remain backwards-compatible by leaving `stopReason` unset.

Whisper transcription metadata now exposes backend and GPU stats in the final stats frame. Applications that surface performance diagnostics can show whether work ran on CPU or GPU and, where supported, report GPU memory information.

```typescript
for await (const ev of sdk.transcribe({ modelId, audioChunk, metadata: true })) {
  if (ev.done && ev.stats) {
    console.log(ev.stats.backendDevice);
    console.log(ev.stats.backendId);
    console.log(ev.stats.gpuMemTotalMb);
    console.log(ev.stats.gpuMemFreeMb);
  }
}
```

## Neural-Signal and Robot-Action APIs Are Available

The SDK now includes BCI transcription backed by whisper.cpp. It supports both batch transcription from a `.bin` path or `Uint8Array`, and streaming duplex sessions over neural-signal chunks.

```typescript
import { loadModel, bciTranscribe, bciTranscribeStream, BCI_WINDOWED } from "@qvac/sdk";

const modelId = await loadModel({ modelSrc: BCI_WINDOWED });
const text = await bciTranscribe({ modelId, neuralData: "./signal.bin" });

const session = await bciTranscribeStream({ modelId, emit: "delta" });
session.write(chunk);
session.end();

for await (const token of session) {
  process.stdout.write(token);
}
```

This release also integrates the pi05 VLA model path for robot-action inference. The VLA API can inspect model hparams, preprocess camera frames, and run action generation with the required image, token, mask, and noise inputs.

```typescript
import { loadModel, vla, vlaHparams, vlaPreprocessImage, PI05_BASE_Q_AGGRESSIVE } from "@qvac/sdk";

const modelId = await loadModel({ modelSrc: PI05_BASE_Q_AGGRESSIVE, modelType: "ggml-vla" });
const { hparams } = await vlaHparams({ modelId });
const size = hparams.visionImageSize;
const images = [cam0, cam1, cam2].map((px) => vlaPreprocessImage(px, w, h, { size }));

const { actions } = await vla({
  modelId,
  images,
  imgWidth: size,
  imgHeight: size,
  state: new Float32Array(0),
  tokens,
  mask,
  noise,
});
```

## Runtime Fixes and Dependency Cleanup

Same-model requests are now serialized through a per-model FIFO queue, which prevents concurrent requests for the same model kind and ID from stepping on each other. Delegated inference also waits for a cold DHT before connecting and categorizes connect failures more clearly, making peer connection failures easier to diagnose.

Several compatibility fixes landed across mobile and bundler environments. The SDK strips multi-GPU config on mobile, avoids exiting in-process Bare hosts when closing the bare client, prevents Android Parakeet GPU backend discovery, fixes Bare config loading through `require()`, and keeps the models subpath compatible with Metro. Dependency metadata was also cleaned up so optional integrations are modeled as optional peer dependencies rather than always-installed optional dependencies.

## Model Registry Updates

This release adds new first-class constants for BCI, image-to-video, multimodal LLMs, Parakeet, Chatterbox TTS, and pi05 VLA usage. The full list is included below so consumers can update imports directly.

### Added Models

```text
BCI_EMBEDDER
BCI_WINDOWED
CLIP_VISION_H
MMPROJ_GEMMA4_2B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0
PARAKEET_EOU_120M_V1_Q4_0
PARAKEET_SORTFORMER_4SPK_V1_Q4_0
PARAKEET_TDT_0_6B_V3_Q4_0
PI05_BASE_Q_AGGRESSIVE
QWEN3_5_0_8B_MULTIMODAL_Q6_K
SMOLLM2_360M_INST_Q8
TTS_S3GEN_EN_CHATTERBOX_Q4_0
TTS_S3GEN_EN_CHATTERBOX_Q5_0
TTS_S3GEN_EN_CHATTERBOX_Q8_0
TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0
TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q5_0
TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q8_0
TTS_T3_MULTILINGUAL_CHATTERBOX_Q5_0
TTS_T3_TURBO_EN_CHATTERBOX_Q5_0
WAN2_1_I2V_14B_Q4_K_M
WAN2_1_I2V_14B_Q4_K_M_1
```
