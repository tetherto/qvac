# 🔌 API Changes v0.13.0

## Surface bare worker crash and shutdown as RPC errors

PR: [#2350](https://github.com/tetherto/qvac/pull/2350)

```typescript
import { WorkerCrashedError, WorkerShutdownError } from "@qvac/sdk";

try {
  await sdk.embed({ modelId, text: "hi" });
} catch (err) {
  if (err instanceof WorkerCrashedError) {
    // err.exitCode, err.exitSignal — bare worker died unexpectedly.
  } else if (err instanceof WorkerShutdownError) {
    // SDK is shutting down; this call was in-flight when close() ran.
  }
}
```

---

## Add img2vid (image-to-video) support to video generation in SDK

PR: [#2436](https://github.com/tetherto/qvac/pull/2436)

```typescript
// Accepted (multiple of 8) — later failed inside the native addon
video({ modelId, mode: "txt2vid", prompt: "...", width: 520, height: 264 });
```

```typescript
// Rejected at the schema boundary — width/height must be multiples of 16
video({ modelId, mode: "txt2vid", prompt: "...", width: 528, height: 272 });
```

```typescript
import fs from "node:fs";

const firstFrame = fs.readFileSync("portrait.png");
const { outputs } = video({
  modelId,            // Wan pipeline loaded with modelConfig.clipVisionModelSrc = "clip_vision_h.safetensors"
  mode: "img2vid",
  prompt: "the subject slowly turns and smiles, cinematic lighting",
  init_image: firstFrame,
  strength: 0.85,     // optional denoise strength in [0, 1]
});

const buffers = await outputs;
fs.writeFileSync("output.avi", buffers[0]);
```

```
CLIP_VISION_H
WAN2_1_I2V_14B_Q4_K_M
WAN2_1_I2V_14B_Q4_K_M_1
```

---

## Add electron-forge plugin for native addon tree-shaking

PR: [#2480](https://github.com/tetherto/qvac/pull/2480)

```typescript
// forge.config.cjs
const QvacForgePlugin = require("@qvac/sdk/electron-forge");

module.exports = {
  packagerConfig: { name: "MyApp" },
  plugins: [
    new QvacForgePlugin({
      // all options optional:
      // configPath: "./qvac.config.json",        // auto-discovered if omitted
      // hosts: ["darwin-arm64", "darwin-x64"],   // derived from --platform/--arch if omitted
      // logLevel: "info",                        // off | error | warn | info | debug
    }),
  ],
};
```

---

## Emit stopReason="length" on token budget exhaustion

PR: [#2484](https://github.com/tetherto/qvac/pull/2484)

```typescript
// CompletionFinal now includes stopReason
const run = completion({ modelId, history, generationParams: { predict: 10 } });
const final = await run.final;
// final.stopReason === "length" when budget was hit
// final.stopReason === "cancelled" when request was cancelled
// final.stopReason === undefined for natural EOS (backwards-compatible)
```

---

## Bump transcription-whispercpp to 0.9.0 and surface backend/GPU stats

PR: [#2488](https://github.com/tetherto/qvac/pull/2488)

```typescript
// transcribe(...) now surfaces whisper backend/GPU info in the final stats frame
for await (const ev of sdk.transcribe({ modelId, audioChunk, metadata: true })) {
  if (ev.done && ev.stats) {
    console.log(ev.stats.backendDevice);  // 0 = CPU, 1 = GPU
    console.log(ev.stats.backendId);      // GPU backend family (BackendId enum)
    console.log(ev.stats.gpuMemTotalMb);  // -1 when no memory accounting
    console.log(ev.stats.gpuMemFreeMb);
  }
}
```

---

## Add BCI (whisper.cpp) neural-signal transcription to the SDK

PR: [#2494](https://github.com/tetherto/qvac/pull/2494)

```typescript
import { loadModel, bciTranscribe, bciTranscribeStream, BCI_WINDOWED } from "@qvac/sdk";

const modelId = await loadModel({ modelSrc: BCI_WINDOWED });

// Batch — neuralData is a .bin path or a Uint8Array buffer
const text = await bciTranscribe({ modelId, neuralData: "./signal.bin" });

// Streaming — duplex session over neural-signal chunks
const session = await bciTranscribeStream({ modelId, emit: "delta" });
session.write(chunk); // Uint8Array
session.end();
for await (const t of session) process.stdout.write(t);
```

---

## Integrate π₀.₅ (pi05) VLA model into @qvac/sdk

PR: [#2508](https://github.com/tetherto/qvac/pull/2508)

```
  Hparams: { numCameras: 3, stateInputMode: "discrete", ... }
  Got 50 action steps of dim 32.
  Timing: vision=4351ms prefill=11446ms ode=2014ms total=17812ms
  ```

```typescript
import { loadModel, vla, vlaHparams, vlaPreprocessImage, PI05_BASE_Q_AGGRESSIVE } from "@qvac/sdk";

const modelId = await loadModel({ modelSrc: PI05_BASE_Q_AGGRESSIVE, modelType: "ggml-vla" });
const { hparams } = await vlaHparams({ modelId });
// hparams.numCameras === 3, hparams.stateInputMode === "discrete"

const size = hparams.visionImageSize; // 224
const images = [cam0, cam1, cam2].map((px) => vlaPreprocessImage(px, w, h, { size }));
const { actions } = await vla({
  modelId,
  images,                          // 3 camera frames
  imgWidth: size, imgHeight: size,
  state: new Float32Array(0),      // discrete state → ignored buffer
  tokens, mask,
  noise,                           // required by π₀.₅
});
```

---

