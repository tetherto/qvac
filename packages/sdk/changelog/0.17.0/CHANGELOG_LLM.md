# QVAC SDK v0.17.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.17.0

QVAC SDK 0.17.0 adds music generation through AudioGen (ACE-Step), unifies Whisper and Parakeet behind a single ASR addon without changing the transcription API, and teaches the SDK to parse DeepSeek V3.2/V4 DSML tool calls. It also ships backend-selection diagnostics and opt-in profiler resource gauges, tightens automatic KV cache disk use, and refreshes the model registry with AudioGen, DeepSeek V4, MoE 35B, and related constants.

## New APIs

### AudioGen Music Generation

You can now generate music from a text caption through the unified SDK surface. Load the ACE-Step stack (text encoder, language model, DiT, and VAE), then stream progress and receive PCM audio. Generation is cancellable via the shared `cancel` API.

```typescript
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioGen,
  cancel,
  loadModel,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "audiogen",
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16,
  },
});

const run = audioGen({ modelId, caption: "ambient electronic music" });
stopButton.onclick = () => cancel({ requestId: run.requestId });

for await (const progress of run.progressStream) {
  console.log(progress.stage, progress.step, progress.total);
}

const { pcm, sampleRate, channels } = await run.audio;
```

### DSML Tool Calls for DeepSeek V3.2 / V4

DeepSeek V3.2 and V4 emit tool calls in DSML (DeepSeek Markup Language). The SDK now parses that dialect so tool calls surface on `toolCallStream` instead of leaking raw markup into content. Set `toolDialect: "dsml"` explicitly, or let the SDK auto-detect it from DeepSeek V3.2 / V4 model ids.

```typescript
const result = completion({
  modelId,
  history: [{ role: "user", content: "What's the weather in Tokyo?" }],
  stream: true,
  tools,
  toolDialect: "dsml", // optional — auto-detected for deepseek-v4 / deepseek-v3.2
});

for await (const evt of result.toolCallStream) {
  if (evt.type === "toolCall") console.log(evt.call.name, evt.call.arguments);
}
```

### Emitted vs Generated Token Counts

Completion stats now distinguish decode length from what was actually emitted. Prefer `emittedTokens` for OpenAI-compatible usage accounting; keep using `generatedTokens` for length / KV-cache budget decisions. Serve endpoints prefer `emittedTokens` when present.

```typescript
const stats = await result.stats;
// Decode count — length / KV-cache budget decisions
stats?.generatedTokens;
// Addon-streamed non-empty pieces — prefer for OpenAI usage accounting
stats?.emittedTokens;
```

### Backend Diagnostics Contract

When the profiler is enabled, backend-selection events can report which backend was chosen and why a fallback occurred, so you can see selection and fallback reasons without digging through logs.

```typescript
import { profiler } from "@qvac/sdk";

profiler.enable({ mode: "verbose" });
profiler.onRecord((event) => {
  if (event.backend?.fallback) {
    console.log(
      `Selected ${event.backend.selectedBackend} after fallback:`,
      event.backend.fallback.reason,
    );
  }
});
```

### Opt-In Profiler Resource Gauges

Pass `includeResourceGauges: true` when enabling the profiler to attach per-event resource gauge snapshots to the exported profile.

```typescript
import { profiler } from "@qvac/sdk";

profiler.enable({
  mode: "verbose",
  includeResourceGauges: true,
});

const profile = profiler.exportJSON();
console.log(profile.recentEvents?.map((event) => event.resources));
```

## Features

### Unified ASR Addon

Whisper and Parakeet transcription now run through the unified `@qvac/asr-ggml` addon. Existing transcription callers keep the same SDK contract; adapters normalize segments, VAD scores, end-of-turn sources, and runtime stats back to the stable surface while dependencies and examples move onto the shared ASR package.

## Bug Fixes

`clearPlugins` now finishes cleanup even when a plugin's `releaseLogger` throws, so a failing logger teardown cannot leave plugins half-cleared.

Automatic KV caches under `~/.qvac/kv-cache` are bounded with a 24-hour idle TTL and a 4 GiB least-recently-used quota. Caller-owned named caches are left alone; empty hash directories from rename/rollback/failed-prime paths are pruned.

## Model Changes

This release adds AudioGen (ACE-Step) model constants and refreshes the registry with DeepSeek V4, MoE 35B, GR00T variants, UMT5, and ABot-World entries.

### Added Models

```text
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
ABOT_WORLD_0_5B_Q8_0
AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0
AUDIOGEN_ACESTEP_V15_SFT_Q8_0
AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M
AUDIOGEN_ACESTEP_V15_TURBO_Q8_0
AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0
AUDIOGEN_VAE_BF16
DEEPSEEK_V4_304B_INST_UD_IQ2_M_SHARD
GROOT_Q5_VF16_1
GROOT_Q8_VF16_1
MOE_35B_INST_IQ2_XXS
MOE_35B_INST_Q4_K_M
MOE_35B_INST_Q8_0
UMT5_XXL_ENC_Q8_0
```
