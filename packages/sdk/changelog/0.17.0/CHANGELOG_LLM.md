# QVAC SDK v0.17.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.17.0

QVAC SDK 0.17.0 adds music generation through AudioGen (ACE-Step), Parler-TTS, Wan 2.2 video, and local system-resource diagnostics. It unifies Whisper and Parakeet behind a single ASR addon, adds DeepSeek DSML tool-call parsing, GR00T multi-embodiment selection, backend diagnostics, and opt-in profiler resource gauges. It also removes legacy ONNX OCR constants, tightens automatic KV cache disk use, and refreshes the model registry.

## Breaking Changes

### Legacy ONNX OCR Constants Removed

Legacy ONNX OCR model constants are no longer exported. Use the GGML-OCR equivalents that already ship in the SDK.

**Before:**

```typescript
import { OCR_CRAFT_DETECTOR, OCR_LATIN_RECOGNIZER } from '@qvac/sdk'
```

**After:**

```typescript
import { OCR_CRAFT, OCR_LATIN } from '@qvac/sdk'
```

Migration notes:

- `OCR_CRAFT_DETECTOR` → `OCR_CRAFT`, `OCR_LATIN_RECOGNIZER` → `OCR_LATIN`
- `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL` → `OCR_DOCTR`, `OCR_DETECTOR_DB_MOBILENET_V3_LARGE` → `OCR_DOCTR_1`
- Non-Latin per-script recognizers have no GGML replacement today. Track GGML-OCR coverage before upgrading if you depend on those scripts.

### Wan 2.2 Single-Expert Validation

Wan 2.2 A14B-only options such as `high_noise_steps` are rejected for single-expert models like TI2V-5B before generation starts. Omit `high_noise_*` and `moe_boundary` options for TI2V-5B and use the single-expert parameters instead.

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
  loadModel
} from '@qvac/sdk'

const modelId = await loadModel({
  modelType: 'audiogen',
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16
  }
})

const run = audioGen({ modelId, caption: 'ambient electronic music' })
stopButton.onclick = () => cancel({ requestId: run.requestId })

for await (const progress of run.progressStream) {
  console.log(progress.stage, progress.step, progress.total)
}

const { pcm, sampleRate, channels } = await run.audio
```

### Parler-TTS

Parler-TTS models are available through the public text-to-speech API, including description-conditioned voice controls and emotion options.

```typescript
const modelId = await loadModel({
  modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
  modelConfig: {
    ttsEngine: 'parler',
    voice: 'Laura',
    seed: 42
  }
})

const result = textToSpeech({
  modelId,
  text: 'Hey, how are you doing today?',
  inputType: 'text',
  stream: false,
  emotion: 'happy'
})

const audio = await result.buffer
```

### Local System Resources

`getSystemResources` reports locally observed CPU, system-memory, GPU, and driver capabilities. Pass `sample: true` only when you also need a fresh usage sample. Metrics use `supported`, `unavailable`, `unverified`, or `failed` status and do not reserve memory or guarantee a model can load.

```typescript
import { getSystemResources } from '@qvac/sdk'

const resources = await getSystemResources({ sample: true })

if (resources.capabilities.memory.totalBytes.status === 'supported') {
  console.log(resources.capabilities.memory.totalBytes.value)
}

if (resources.sample?.cpu.status === 'supported') {
  console.log(resources.sample.cpu.value)
}
```

### DSML Tool Calls for DeepSeek V3.2 / V4

DeepSeek V3.2 and V4 emit tool calls in DSML (DeepSeek Markup Language). The SDK now parses that dialect so tool calls surface on `toolCallStream` instead of leaking raw markup into content. Set `toolDialect: "dsml"` explicitly, or let the SDK auto-detect it from DeepSeek V3.2 / V4 model ids.

```typescript
const result = completion({
  modelId,
  history: [{ role: 'user', content: "What's the weather in Tokyo?" }],
  stream: true,
  tools,
  toolDialect: 'dsml' // optional — auto-detected for deepseek-v4 / deepseek-v3.2
})

for await (const evt of result.toolCallStream) {
  if (evt.type === 'toolCall') console.log(evt.call.name, evt.call.arguments)
}
```

### Emitted vs Generated Token Counts

Completion stats now distinguish decode length from what was actually emitted. Prefer `emittedTokens` for OpenAI-compatible usage accounting; keep using `generatedTokens` for length / KV-cache budget decisions. Serve endpoints prefer `emittedTokens` when present.

```typescript
const stats = await result.stats
// Decode count — length / KV-cache budget decisions
stats?.generatedTokens
// Addon-streamed non-empty pieces — prefer for OpenAI usage accounting
stats?.emittedTokens
```

### Context-Boundary Termination

Streamed completions that fill the model context window now finish with a length stop instead of stalling forever. Generation-time context exhaustion maps to a terminal `length` outcome; incomplete KV-cache turns are rolled back.

### GR00T Multi-Embodiment Selection

Multi-embodiment GR00T GGUFs can select an embodiment at load and switch at runtime without a full reload via `vlaSetEmbodiment`. `vlaHparams` reports the resolved embodiment tag and category id.

```typescript
import { loadModel, vlaHparams, vlaSetEmbodiment, GROOT_MULTI_Q8_VF16 } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: GROOT_MULTI_Q8_VF16,
  modelType: 'ggml-vla',
  modelConfig: { embodiment: 'libero_sim' }
})

const { hparams } = await vlaHparams({ modelId })
hparams.selectedEmbodimentTag // 'libero_sim'

const { hparams: refreshed } = await vlaSetEmbodiment({
  modelId,
  embodiment: 24
})
refreshed.numCameras // camera count follows the new embodiment
```

### Backend Diagnostics Contract

When the profiler is enabled, backend-selection events can report which backend was chosen and why a fallback occurred, so you can see selection and fallback reasons without digging through logs.

```typescript
import { profiler } from '@qvac/sdk'

profiler.enable({ mode: 'verbose' })
profiler.onRecord((event) => {
  if (event.backend?.fallback) {
    console.log(
      `Selected ${event.backend.selectedBackend} after fallback:`,
      event.backend.fallback.reason
    )
  }
})
```

### Opt-In Profiler Resource Gauges

Pass `includeResourceGauges: true` when enabling the profiler to attach per-event resource gauge snapshots to the exported profile.

```typescript
import { profiler } from '@qvac/sdk'

profiler.enable({
  mode: 'verbose',
  includeResourceGauges: true
})

const profile = profiler.exportJSON()
console.log(profile.recentEvents?.map((event) => event.resources))
```

## Features

### Worker Resource Collector

The worker now hosts independent CPU and GPU collectors that cache inventory and sample on demand. Missing or ambiguous metrics normalize to explicit statuses without affecting model loading.

### Unified ASR Addon

Whisper and Parakeet transcription now run through the unified `@qvac/asr-ggml` addon. Existing transcription callers keep the same SDK contract; adapters normalize segments, VAD scores, end-of-turn sources, and runtime stats back to the stable surface while dependencies and examples move onto the shared ASR package.

### Wan 2.2 Video Support

Wan 2.2 single-expert and dual-expert model layouts are wired through `@qvac/diffusion-cpp`, including a runnable TI2V-5B text-to-video example.

## Bug Fixes

Declaration output now emits NodeNext-compatible `.js` specifiers for internal references, so model constants resolve under `moduleResolution: "NodeNext"`.

`clearPlugins` now finishes cleanup even when a plugin's `releaseLogger` throws, so a failing logger teardown cannot leave plugins half-cleared.

Automatic KV caches under `~/.qvac/kv-cache` are bounded with a 24-hour idle TTL and a 4 GiB least-recently-used quota. Caller-owned named caches are left alone; empty hash directories from rename/rollback/failed-prime paths are pruned.

## Model Changes

This release refreshes registry constants (including CosyVoice3, LTX 2.3, Wan 2.2, and Gemma), adds AudioGen (ACE-Step) and GR00T multi-embodiment constants, and removes legacy ONNX OCR exports.

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
GEMMA_3_12B_Q4_K_XL
GROOT_MULTI_Q5_VF16
GROOT_MULTI_Q8_VF16
GROOT_Q5_VF16_1
GROOT_Q8_VF16_1
LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS
LTX_2_3_22B_Q2_K
LTX_2_3_22B_Q5_K_M
LTX_2_3_VAE
LTX_2_3_VAE_1
MMPROJ_OCR_3B_MULTIMODAL_F16
MMPROJ_OCR_3B_MULTIMODAL_Q8_0
MOE_35B_INST_IQ2_XXS
MOE_35B_INST_Q4_K_M
MOE_35B_INST_Q8_0
OCR_3B_MULTIMODAL_Q4_0
TTS_COSYVOICE3_FLOW_COSYVOICE_FP32
TTS_COSYVOICE3_HIFT_COSYVOICE_FP32
TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
TTS_COSYVOICE3_TOKENIZER_COSYVOICE
TTS_COSYVOICE3_TOKENIZER_COSYVOICE_1
TTS_COSYVOICE3_VOICE_COSYVOICE
TTS_COSYVOICE3_VOICE_COSYVOICE_1
TTS_COSYVOICE3_VOICE_COSYVOICE_2
UMT5_XXL_ENC_Q8_0
WAN2_2_TI2V_5B_Q5_K_S
WAN_2_2_COMFYUI_REPACKAGED_VAE
```

### Removed Models

```text
OCR_ARABIC_RECOGNIZER
OCR_BENGALI_RECOGNIZER
OCR_CRAFT_DETECTOR
OCR_CYRILLIC_RECOGNIZER
OCR_DETECTOR_DB_MOBILENET_V3_LARGE
OCR_DETECTOR_DB_RESNET50
OCR_DEVANAGARI_RECOGNIZER
OCR_JAPANESE_RECOGNIZER
OCR_KANNADA_RECOGNIZER
OCR_KOREAN_RECOGNIZER
OCR_LATIN_RECOGNIZER
OCR_LATIN_RECOGNIZER_1
OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL
OCR_RECOGNIZER_PARSEQ
OCR_TAMIL_RECOGNIZER
OCR_TELUGU_RECOGNIZER
OCR_THAI_RECOGNIZER
OCR_ZH_SIM_RECOGNIZER
OCR_ZH_TRA_RECOGNIZER
```
