## 🎯 What problem does this PR solve?

- SDK had no first-class API for text-to-video generation.

## 📝 How does it solve it?

- Add `video()` client API mirroring `diffusion()`: returns `{ progressStream, outputs, stats }`, base64-encodes the optional `control_frames` array on the way in and decodes generated frame chunks into `Uint8Array[]` on the way out.
- Add a `videoStream` RPC handler and a `sdcpp-generation` plugin op (`ops/video.ts`) that streams `step/totalSteps/elapsedMs` progress, then `data` + `done` + `stats`.
- Extend `schemas/sdcpp-config.ts` with WAN-specific video config (vae/t5/clip_vision/control models, sampling, control frames) and surface `VideoClientParams`, `VideoStreamResponse`, `VideoStats` (also re-exported via `schemas/common.ts` and `index.ts`).
- Update `client/api/load-model.ts` to support loading the new WAN video model bundle.
- Refresh `models/registry/models.ts` (and the corresponding `models/history/3b2570ce.txt` snapshot) to add WAN model entries used by the video API.
- Wire profiling for the new op (`operation-metrics.ts`) and register cancel capability.
- Minor: tweak to `.cursor/rules/sdk/request-lifecycle-primitives.mdc`.

Note: additionally added an example and a script to the diffusion add-on that were missed in the txt2vid PR.

## 🧪 How was it tested?

- Unit tests:
  - `packages/sdk/test/unit/sdcpp-video-ops.test.ts` (plugin op: base64 decoding, mode forwarding, stream responses)
  - `packages/sdk/test/unit/sdcpp-video-schemas.test.ts` (schema: `video_frames`, `fps`, `moe_boundary`, base64 input validation)
  - `plugin-cancel-capability.test.ts` updated for the new op.
- E2E: new `tests-qvac/tests/video-tests.ts` + desktop `video-executor.ts` registered in `tests/desktop/consumer.ts` and `test-definitions.ts`; mobile consumer registers a skip entry.

## 🔌 API Changes

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