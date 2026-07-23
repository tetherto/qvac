# 💥 Breaking Changes v0.13.0

## Add img2vid (image-to-video) support to video generation in SDK

PR: [#2436](https://github.com/tetherto/qvac/pull/2436)

**BEFORE:**
```typescript
// Accepted (multiple of 8) — later failed inside the native addon
video({ modelId, mode: "txt2vid", prompt: "...", width: 520, height: 264 });
```

**AFTER:**
```typescript
// Rejected at the schema boundary — width/height must be multiples of 16
video({ modelId, mode: "txt2vid", prompt: "...", width: 528, height: 272 });
```

## 🧪 How was it tested?

- Unit tests updated/added for the new schema (`sdcpp-video-schemas.test.ts`) and the bare video op `init_image`/`strength` handling (`sdcpp-video-ops.test.ts`).
- Desktop e2e video tests + executor extended to cover the `img2vid` path.
- Added runnable example `examples/diffusion-img2vid.ts`.

## 🔌 API Changes

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

## 📦 Models

> [!NOTE]
> There are 13 additional models that were pulled in by `bun run update-models` because the constants were not updated after those models landed into the registry.

Added models:
```
CLIP_VISION_H
WAN2_1_I2V_14B_Q4_K_M
WAN2_1_I2V_14B_Q4_K_M_1
```

---
- To see the specific tasks where the Asana app for GitHub is being used, see below:
  - https://app.asana.com/0/0/1215286501730890

---

