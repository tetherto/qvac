# @qvac/tts-ggml

Text-to-speech Bare addon backed by the [`qvac-tts.cpp`][qvac-tts-cpp]
GGML library.  Wraps multiple engines under one package: **Chatterbox**
(Turbo English + multilingual), **Supertonic** (v3 31-language preferred;
v1/v2 still loadable), **Parler** (mini/large English + indic 21-language,
description-conditioned with voice/emotion templates), **CosyVoice3**
(Fun-CosyVoice3-0.5B, instruct-conditioned, 24 kHz, CPU with opt-in
Metal on Apple, Vulkan on Linux/Windows, and OpenCL/Adreno GPU offload
on Android), and **Audio8**
(DualAR + neural codec, in-process voice cloning, desktop Vulkan), plus optional
LavaSR neural denoise + 48 kHz bandwidth-extension enhancement.  Unsure
which checkpoint to stage? Start with [Choosing a model](#choosing-a-model).


Runs in-process with a persistent native engine — the GGUFs, the S3Gen
preload, the ggml backend, and any voice-conditioning tensors are
loaded once and reused across every synthesis call.  GPU acceleration
(Metal on macOS/iOS, Vulkan on Linux/Windows, Vulkan / OpenCL on Android)
is **opt-in** via `config: { useGPU: true }`; the default is CPU.  On
Android `useGPU` flows through to `tts-cpp`, which picks the GPU
backend per its own per-vendor allowlist (Adreno → OpenCL,
Xclipse/Mali → Vulkan). Parler supports Apple/Metal and the validated
Android paths, including Vulkan on ARM Mali (see
[Backends & GPU acceleration](#backends--gpu-acceleration)). Audio8 supports
Vulkan offload on Linux and Windows.

[qvac-tts-cpp]: https://github.com/tetherto/qvac-ext-lib-whisper.cpp/tree/master/tts-cpp

## Features

- Batch synthesis (`run({ input })` → single PCM buffer).
- **Sentence-granularity streaming** — `runStreaming(asyncIterable)`:
  yields one audio chunk per input sentence.
- **Native per-chunk streaming** — set `streamChunkTokens` and audio
  flows out of the C++ engine chunk-by-chunk as T3 tokens produce
  S3Gen+HiFT output; sub-second first-audio-out inside a single
  utterance.
- **Voice cloning** from a reference wav (or a pre-baked profile dir);
  on Audio8 the reference is encoded in-process and can be switched per
  call.
- **CPU by default**, GPU (Metal / Vulkan / OpenCL) opt-in via
  `config.useGPU: true` on GPU-capable hosts — including Android, where
  `tts-cpp` selects the GPU backend per its per-vendor allowlist (see
  [Backends & GPU acceleration](#backends--gpu-acceleration)).
- **Dynamic backend loading on Android** — per-arch CPU + Vulkan +
  OpenCL `.so` files ship under `prebuilds/<bare-target>/qvac__tts-ggml/`
  and are picked up at runtime via the new `backendsDir` option (see
  [Backends & GPU acceleration](#backends--gpu-acceleration)).
- **Cancellation** via `model.cancel()` — stops T3 decode on the next
  token; in-flight S3Gen chunk runs to completion.

## Choosing a model

Pick a **specific GGUF** (or CosyVoice3 model directory), not only an engine
family. Capabilities overlap; the tables below weight language coverage,
latency, size, and control surface so the default recommendation is
obvious for each job.

### Decision guide

| If you need… | Use this model | Notes |
| --- | --- | --- |
| Lowest RTF on phones / edge devices | `supertonic3-q4_0.gguf` (or `supertonic3-q8_0.gguf` for quality) | ~80 MB (`q4_0`) / ~126 MB (`q8_0`); 31 languages. Prefer v3 over v1/v2. |
| English + voice cloning + low first-audio latency | `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` | Reference-wav / voice-profile cloning; native `streamChunkTokens` chunk streaming. Native 24 kHz. |
| Multilingual + voice cloning (EU / CJK) | `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` | en/es/fr/de/pt/it/zh/ja/ko/…; same cloning + streaming surface as Turbo. |
| Voice cloning at 44.1 kHz with nothing pre-baked | `audio8-lm-q8_0.gguf` + `audio8-codec-decoder-q8_0.gguf` (+ `audio8-codec-encoder-q8_0.gguf` to clone) | Clones from a reference wav **and its transcript**, encoded in-process — no enrolment step, no voice profile. Whole-utterance only (no native chunk streaming). |
| Indic languages | `parler-indic-q8_0.gguf` | 21 Indic languages; voice / emotion templates. Emotion is officially tested on 10 languages — see [Parler descriptions & emotions](#parler-descriptions--emotions) (or the upstream model card). Native 44.1 kHz. |
| Chinese dialects (Cantonese, Sichuan, Shanghai, …) | CosyVoice3 dir (`cosyvoice3-llm-*.gguf` + flow / hift / `voice.gguf`) | Instruct-conditioned; 17 dialects via `instruct: { dialect: '…' }`. CPU, with opt-in GPU offload (Metal on Apple, Vulkan on Linux/Windows, OpenCL/Adreno on Android); native 24 kHz. |
| Zero-shot / cross-lingual cloning (multilingual) | CosyVoice3 dir + `cosyvoice3-s3tok-*.gguf` + `cosyvoice3-campplus-*.gguf` | Clones from a reference wav; its transcript (`promptText`) selects zero-shot, omitting it selects cross-lingual (timbre only, any target language). Composes with `instruct`. |
| Description-conditioned English (caption / emotion) | `parler-mini-v1-q8_0.gguf` | Recommended English Parler checkpoint for caption / emotion control. |
| Voice cloning with noisy input audio | Any engine above + `lavasr-denoiser.gguf` | Post-process (batch path); cleans before optional enhancement. See [Speech enhancement (LavaSR)](#speech-enhancement-lavasr). |
| 48 kHz bandwidth-extended output | Any engine above + `lavasr-enhancer.gguf` | Post-process, not a TTS engine. Optional `lavasr-denoiser.gguf` first (batch path). |

GPU / backend support is documented in
[Backends & GPU acceleration](#backends--gpu-acceleration) — not duplicated
here, so this guide does not go stale when backends change.

### Capability matrix

| Model | Languages | Size (approx.) | Sample rate | Voice control | Streaming |
| --- | --- | ---: | ---: | --- | --- |
| `supertonic3-q4_0` / `q8_0` / `f16` | 31 | ~80 / ~126 / ~191 MB | 44.1 kHz | Baked voice ids (`F1`, `M1`, …) | Sentence streaming |
| `chatterbox-t3-turbo` + `s3gen` | English | ~1.7 GB | 24 kHz | Reference wav / voice dir | Sentence + native chunk |
| `chatterbox-t3-mtl` + `s3gen-mtl` | Multilingual | ~2.0 GB | 24 kHz | Reference wav / voice dir | Sentence + native chunk |
| `parler-indic-q8_0` | 21 Indic | ~1.3 GB | 44.1 kHz | `voice` / `emotion` / description | Sentence streaming |
| `parler-mini-v1-q8_0` | English | ~1.2 GB | 44.1 kHz | Description / templates | Sentence streaming |
| CosyVoice3 (`cosyvoice3/`) | Instruct-led (strong on Chinese + dialects) | ~2.3 GB dir (+ ~300 MB to clone) | 24 kHz | Reference wav (zero-shot / cross-lingual) + `instruct` (dialect / emotion / speed / volume / style) | Native chunk opts |
| `audio8-lm-q8_0` + codec halves | Text-led (no `language` option) | ~0.7 GB (+ ~120 MB to clone) | 44.1 kHz | Reference wav + transcript, per call too | Sentence streaming |

### Legacy Supertonic v1 / v2

| Model | Status | Why |
| --- | --- | --- |
| `supertonic.gguf` (v1, English) | **Not recommended for new integrations** | Supertonic 3 covers English and is the edge/RTF default. No reason to prefer v1 over v3. |
| `supertonic2.gguf` (en/ko/es/pt/fr) | **Not recommended for new integrations** | Supertonic 3 is a strict superset (31 languages, same engine path, published quant tiers). Prefer `supertonic3-*.gguf`. |

Both remain loadable for existing apps and CI. New projects should stage
Supertonic 3 only unless a pinned dependency still requires v1/v2.

### Quick defaults

- **Mobile / low RTF:** `supertonic3-q4_0.gguf`
- **Product English with cloning:** Chatterbox Turbo GGUF pair
- **Indic product:** `parler-indic-q8_0.gguf`
- **Chinese dialect product:** CosyVoice3 model directory

See [Model files](#model-files) for on-disk layouts and
[API overview](#api-overview) for constructor options.

## Install

```bash
npm install @qvac/tts-ggml
```


Requires [Bare](https://github.com/holepunchto/bare) `>=1.19.0`.
Prebuilds are published for Linux x64/arm64, macOS x64/arm64, Windows x64,
Android arm64, iOS arm64 devices, and iOS x64/arm64 simulators. Unsupported
targets must [build from source](#build-from-source); installation does not
automatically compile a local addon.

## Model files

Five engine families are wrapped (Chatterbox, Supertonic, Parler,
CosyVoice3, Audio8), each with its own GGUF layout under `models/`:

```
# Chatterbox turbo (English)
chatterbox-t3-turbo.gguf   (~742 MB) — T3 GPT-2 Medium + BPE + VoiceEncoder
chatterbox-s3gen.gguf      (~1.0 GB) — S3Gen encoder/CFM + HiFT + CAMPPlus + S3TokenizerV2

# Chatterbox multilingual (en/es/fr/de/pt/it/zh/ja/ko/...)
chatterbox-t3-mtl.gguf     (~1.0 GB)
chatterbox-s3gen-mtl.gguf  (~1.0 GB)

# Supertonic 3 (Supertone/supertonic-3; 31 languages) — preferred Supertonic
# checkpoint; published per quant tier (auto-detected from modelDir)
supertonic3-q4_0.gguf      (~80 MB; also -q8_0 ~126 MB / -f16 ~191 MB / -f32)

# Legacy Supertonic (not recommended for new integrations — see Choosing a model)
supertonic.gguf            (~263 MB) — v1 English only
supertonic2.gguf           (~263 MB) — v2 en/ko/es/pt/fr; subset of v3


# Parler (parler-tts/parler-tts-{mini,large}-v1 + ai4bharat/indic-parler-tts;
# 44.1 kHz, description-conditioned) — published per quant tier
parler-mini-v1-q8_0.gguf   (~1.2 GB; also -q6_k)
parler-large-v1-q8_0.gguf  (~2.8 GB; also -q6_k)
parler-indic-q8_0.gguf     (~1.3 GB; also -f16 / -f32; 21 Indic languages)

# CosyVoice3 (FunAudioLLM/CosyVoice; Qwen2 speech LM + DiT flow + CausalHiFT;
# 24 kHz, CPU with opt-in Metal / Android GPU) — a model DIRECTORY (default
# models/cosyvoice3/), auto-detected
# from the cosyvoice3-llm-*.gguf file
cosyvoice3/
  cosyvoice3-llm-*.gguf    (~973 MB q8_0 — Qwen2.5 speech LM)
  cosyvoice3-flow-*.gguf   (~1.3 GB f32 — DiT conditional-flow-matching)
  cosyvoice3-hift-*.gguf   (~83 MB f32 — CausalHiFT vocoder)
  voice.gguf               (baked default voice: timbre + prompt tensors)
  vocab.json  merges.txt   (Qwen2 BPE tokenizer)
  cosyvoice3-s3tok-*.gguf  (~275 MB q8_0 / ~497 MB f16 — speech tokenizer;
                            voice cloning only)
  cosyvoice3-campplus-*.gguf (~28 MB f32 — CAM++ speaker encoder; cloning only)

# Audio8 (Audio8-AI/Audio8_TTS; 44.1 kHz, DualAR + neural codec) — three
# GGUFs, published per quant tier; the encoder is only needed to clone a voice
audio8-lm-q8_0.gguf              (~0.6 GB; also -f16 / -q4_0 / -f32)
audio8-codec-decoder-q8_0.gguf   (~110 MB; also -f16 / -f32)
audio8-codec-encoder-q8_0.gguf   (~120 MB; also -f16 / -f32; cloning only)
```

Download the registry-published Chatterbox, Supertonic, and Parler models into
`./models`:

```bash
npm run download-models:registry
npm run download-models:registry -- --group chatterbox,supertonic3
npm run download-models:registry -- --output /path/to/models
```

CosyVoice3 and Audio8 are not currently included in that registry command.
Stage their layouts shown above from local converted artifacts. The package
converts upstream Chatterbox, Supertonic, and Parler checkpoints via a Python
venv pipeline:

```bash
npm run setup-models   # creates ./venv, installs requirements.txt, runs convert-models.sh
```

Or step-by-step:

```bash
npm run setup:venv
npm run convert-models
```

The Audio8 GGUFs are produced by the converters in
qvac-ext-lib-whisper.cpp (`engines/tts/scripts/convert-audio8-lm-to-gguf.py`
and `convert-audio8-codec-to-gguf.py`) until they are published to the model
registry alongside the other engines.

Point the addon at a custom location via `files.modelDir` (engine
auto-detected from the gguf filenames present), or pass explicit
`files.t3Model` + `files.s3genModel` (Chatterbox) /
`files.supertonicModel` (Supertonic) / `files.parlerModel` (Parler) /
`files.cosyvoiceModelDir` (CosyVoice3 — a directory, see
[CosyVoice3 instruct](#cosyvoice3-instruct)) /
`files.audio8Lm` + `files.audio8CodecDecoder` (+ `files.audio8CodecEncoder`
to clone) (Audio8).

## Quick start

```js
const TTSGgml = require('@qvac/tts-ggml')

const model = new TTSGgml({
  files: { modelDir: './models' }, // contains chatterbox-{t3-turbo,s3gen}.gguf
  config: { language: 'en' },
  opts: { stats: true }
})

await model.load()

const response = await model.run({
  type: 'text',
  input: 'Hello from qvac tts ggml.'
})

let pcm = []
await response
  .onUpdate(data => {
    if (data && data.outputArray) pcm = pcm.concat(Array.from(data.outputArray))
  })
  .await()

// pcm is Int16 mono @ 24 kHz for Chatterbox (rate varies by engine — see data.sampleRate)
await model.unload()
```

## Streaming

### Sentence streaming — `runStreaming(asyncIter)`

Use when your text arrives as discrete sentences (e.g. buffered LLM
output) and you want the audio to flow sentence-by-sentence.  One
`onUpdate` event per input yield.

```js
async function * sentencesOverTime () {
  yield 'First sentence.'
  await new Promise(r => setTimeout(r, 200))
  yield 'The second arrives shortly after.'
}

const response = await model.runStreaming(sentencesOverTime())
await response.onUpdate(data => {
  // data.outputArray    — Int16 PCM for this sentence's audio
  // data.chunkIndex     — 0-based index of the yielded sentence
  // data.sentenceChunk  — the sentence text that produced this audio
}).await()
```

`runStreaming(textStream, options)` accepts a string, string array, iterable,
or async iterable. Async iterables default to `accumulateSentences: true` so
streamed fragments are buffered until a sentence delimiter is reached; strings,
arrays, and synchronous iterables default to one synthesis job per item. Set
`accumulateSentences` explicitly to override that behavior. Choose
`sentenceDelimiterPreset: 'latin'`,
`'multilingual'`, or `'cjk'`, or provide `sentenceDelimiter: RegExp`.
`maxBufferScalars` bounds buffered text and forces a flush when reached;
`flushAfterMs` flushes text that has remained incomplete for that duration.
Parler description fields and Audio8 `referenceAudio` / `referenceText` may
also be supplied in the options and remain fixed for the response.

Full runnable demo (with streaming playback):
`bare examples/chatterbox-sentence-stream-tts.js`

### Chunk streaming — `streamChunkTokens`

Use when you want the fastest possible first-audio-out **within a
single utterance**.  The C++ engine splits each synthesis into chunks
of `streamChunkTokens` speech tokens (25 ≈ 1 s of audio) and emits
audio per chunk, keeping HiFT's source cache phase-continuous across
seams so the joins are inaudible.

```js
const model = new TTSGgml({
  files: { modelDir: './models' },
  referenceAudio: './voices/jfk.wav', // optional
  streamChunkTokens: 25,              // ~1 s of audio per chunk
  streamFirstChunkTokens: 10,         // smaller first chunk = faster first-audio-out
  cfmSteps: 1,                        // 1-step meanflow: halves CFM cost
  config: { language: 'en' }
})

await model.load()

const response = await model.run({ input: 'A long sentence produces many chunks...' })
await response.onUpdate(data => {
  if (data && data.outputArray) playPcmChunk(data.outputArray)
}).await()
```

Full runnable demo (with gapless playback via `sox` or `ffplay`):
`bare examples/chatterbox-chunk-stream-tts.js`

## Voice cloning

### Chatterbox

Pass a mono wav ≥ 5 s of clean speech — the engine does the loudness
normalisation (−27 LUFS), resampling, and all conditioning (VoiceEncoder,
CAMPPlus, S3TokenizerV2, mel extraction) natively at `load()` time:

```js
const model = new TTSGgml({
  files: { modelDir: './models' },
  referenceAudio: './voices/me.wav',
  config: { language: 'en' }
})
```

Alternatively point at a pre-baked profile directory produced by the
upstream CLI's `--save-voice DIR` (loads `.npy` tensors; skips the
preprocessing entirely):

```js
new TTSGgml({
  files: { modelDir: './models' },
  voiceDir: './voices/me/',
})
```

When both are supplied, missing tensors in `voiceDir` are backfilled
from `referenceAudio`.

### Audio8

Audio8 clones from the recording plus **what is said in it**.  The codec's
analysis half (`files.audio8CodecEncoder`) encodes the recording to codes
inside the addon, and the model continues that speaker; the transcript is
what the reference turn *answers*, so a missing or wrong one degrades the
clone rather than failing loudly.  Both fields are therefore required
together, and cloning without the encoder GGUF is rejected at construction.

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_AUDIO8,
  files: { modelDir: './models' }, // needs audio8-codec-encoder-*.gguf present
  referenceAudio: './voices/me.wav',
  referenceText: 'Exactly what the recording says, verbatim.'
})
await model.load()

// per-call override: a different speaker, or just a corrected transcript
await model.run({
  input: 'Spoken in a third voice.',
  referenceAudio: './voices/someone-else.wav',
  referenceText: 'What that recording says.'
})
```

A per-call `referenceText` on its own corrects the transcript of the
configured recording.  A per-call `referenceAudio` replaces the voice
outright and must bring its own transcript — the configured one describes a
different recording, so it is not inherited — and a recording passed without
one is rejected before the job is queued.  `reload()` applies the same rule,
and checks the merged voice *and* the merged sampling knobs before it writes
either, so a refused reload leaves the model exactly as it was rather than
half-moved onto the configuration that was refused.

The engine caches the codes for the most recent reference, so repeating one
across calls skips the encoder.  Per-call fields also ride on the
`runStream` / `runStreaming` options, pinned for the whole response so the
cache stays hot across chunks.

### CosyVoice3

CosyVoice3 clones **zero-shot or cross-lingual**, selected by whether the
reference's transcript is provided — the same rule as the upstream
frontends.  At `load()` the native front-end tokenizes the recording
(speech_tokenizer_v3), extracts the CAM++ speaker embedding and the prompt
mel, and replaces the baked default voice; the one-time bake costs about a
second of CPU for a short clip.

Zero-shot — transcript given, so the LM is prompted with the transcript and
the reference's speech tokens (best fidelity in the reference's language):

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_COSYVOICE3,
  files: { cosyvoiceModelDir: './models/cosyvoice3' },
  referenceAudio: './voices/me.wav',
  promptText: 'Exactly what the recording says, verbatim.'
})
```

Cross-lingual — no transcript, timbre-only conditioning through the flow
(best when synthesizing a different language than the reference):

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_COSYVOICE3,
  files: { cosyvoiceModelDir: './models/cosyvoice3' },
  referenceAudio: './voices/me.wav'
})
```

`examples/cosyvoice-tts.js` demonstrates both modes end to end
(`--reference-audio` / `--prompt-text`).

The recording must be 0.5-30 s (hard limits; 5-15 s of clean speech clones
most reliably) with finite samples; multichannel input is downmixed to mono
by the engine.  Cloning needs the two add-on GGUFs —
`cosyvoice3-s3tok-*.gguf` (speech tokenizer, f16 or q8_0) and
`cosyvoice3-campplus-*.gguf` (speaker encoder) — auto-discovered under
`files.cosyvoiceModelDir` by those name prefixes, or passed explicitly as
`files.cosyvoiceS3tokModel` / `files.cosyvoiceCampplusModel`.  They are
required **only** when `referenceAudio` is set; every failure (missing
GGUFs, unreadable or out-of-range audio) rejects the load rather than
silently keeping the baked voice.  `instruct` composes with a cloned voice:
the instruction drives dialect/style while the clone supplies the timbre.
The reference is fixed at construction: there is no per-call reference
(unlike Audio8), and `reload()` re-bakes the *same* recording rather than
accepting a new one, so changing voices means constructing a new instance.

## Speech enhancement (LavaSR)

Opt-in neural post-processing that bandwidth-extends the synthesized audio to
**48 kHz** with a synthesised high band, using the LavaSR Vocos enhancer
(ConvNeXt backbone + ISTFT spec head) converted to a single GGUF. It follows the
engine's GPU intent: with `config.useGPU: true` (or `nGpuLayers`) the enhancer
runs on the GPU (Vulkan on Linux/Windows, Metal on macOS/iOS) and falls back to
CPU otherwise. It is fully backward compatible — provide no enhancer GGUF and
nothing changes.

Enhancement is enabled simply by supplying the enhancer GGUF; there is no
separate on/off flag.

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_SUPERTONIC,
  // Providing the enhancer GGUF is what turns enhancement on:
  files: { supertonicModel, lavasrEnhancer: 'models/lavasr/lavasr-enhancer.gguf' },
  config: { language: 'en' }
})
// The output callback now reports 48000:
//   response.onUpdate(d => { /* d.outputArray; d.sampleRate === 48000 */ })
```

The GGUF path may instead be given as `enhancer.enhancerPath` (an
`enhancer: { type: 'lavasr', enhancerPath }` block). Convert the GGUF from the
public [LavaSRcpp](https://github.com/Topping1/LavaSRcpp) ONNX release:

```bash
python scripts/convert-lavasr-enhancer-to-gguf.py \
  --backbone enhancer_backbone.onnx --spec-head enhancer_spec_head.onnx \
  --out models/lavasr/lavasr-enhancer.gguf --ftype f16   # or f32
```

Notes:

- Works for all four engines — Chatterbox, Supertonic, Parler and CosyVoice3 —
  on the batch path, sentence-level streaming, **and** the native chunk
  streaming of Chatterbox, Parler and CosyVoice3 (`streamChunkTokens > 0`).
- For native chunk streaming the enhancer runs over a sliding window with
  look-ahead + crossfade so each emitted chunk is bandwidth-extended seam-free.
  This adds **~0.34 s of look-ahead latency** (inherent to the enhancer's
  receptive field), so first-audio-out arrives a little later than un-enhanced
  streaming.
- That window re-runs the enhancer over a fixed left context + look-ahead around
  every chunk, so streamed enhancement costs a constant factor above a single
  batch pass: **~1.7×** for ~1 s chunks, ~2.7× for ~0.4 s, ~4.4× for ~0.2 s. How
  many tokens that is depends on the engine's speech-token rate (Chatterbox's S3
  tokens run at a fixed 25 Hz, so `streamChunkTokens: 25` ≈ 1 s). The factor is
  flat in utterance length, and the enhancer is only a small share of synthesis,
  so ~1 s chunks cost roughly 2% of total synthesis time.
- That extra enhancer CPU buys a real latency win on **Chatterbox**, so prefer
  larger chunks there only if enhancer CPU matters more to you than first-audio
  latency. On **CosyVoice3** it currently buys nothing: the tts-cpp engine
  computes the whole utterance and only then slices it, so chunks arrive
  progressively but first-audio latency is not yet reduced (true token2wav
  streaming is reserved upstream). Until that lands, prefer **batch** synthesis
  when enhancing CosyVoice3 — streaming there pays the reprocess cost and yields
  a seam-free result that is not bit-identical to the batch pass, with no
  latency benefit in return.
- The enhancer always runs at 48 kHz internally. By default the emitted audio
  is 48 kHz; set `config.outputSampleRate` to resample the enhanced output to a
  different rate (`TTSOutputChunk.sampleRate` reports the actual rate).
- Parler is natively 44.1 kHz, so enhancement there buys spectral detail rather
  than raw bandwidth. It also lifts a streaming restriction: Parler normally
  rejects `config.outputSampleRate` together with `streamChunkTokens` (the engine
  has no seam-free per-chunk resampler), but with the enhancer active the
  requested rate is applied inside the enhancer's overlap windows and is
  accepted.
- CosyVoice3 native chunk streaming otherwise emits only at its native 24 kHz;
  enabling the enhancer is what makes a different `config.outputSampleRate`
  valid there, since the resample happens inside the seam-free window.
- With `opts.stats`, `response.stats.enhancerBackendDevice` (`-1` none / `0` CPU
  / `1` GPU) and `enhancerBackendId` report where the enhancer actually ran.

### Denoiser

LavaSR's first stage — the UL-UNAS **denoiser**, which cleans the signal before
the enhancer bandwidth-extends it — is wired through the addon. It is enabled the
same way as the enhancer, via `files.lavasrDenoiser` (or a
`denoiser: { type: 'lavasr', denoiserPath }` block), and runs before the
enhancer (rate-preserving) on the batch path for all four engines:

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_SUPERTONIC,
  files: {
    supertonicModel,
    lavasrDenoiser: 'models/lavasr/lavasr-denoiser.gguf', // cleaned first…
    lavasrEnhancer: 'models/lavasr/lavasr-enhancer.gguf'  // …then upsampled
  },
  config: { language: 'en' }
})
```

Convert the GGUF from the public [LavaSRcpp](https://github.com/Topping1/LavaSRcpp)
ONNX release using the `convert-lavasr-denoiser-to-gguf.py` script shipped in the
[`qvac-ext-lib-whisper.cpp/tts-cpp`][qvac-tts-cpp] repo (this package ships only
the enhancer converter under `scripts/`):

```bash
python /path/to/tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py \
  --denoiser denoiser_core_legacy_fixed63.onnx \
  --out models/lavasr/lavasr-denoiser.gguf --ftype f16   # or f32
```

Notes:

- The UL-UNAS forward runs at 16 kHz internally (resampled in/out), so the
  denoiser is **rate-preserving**: the emitted audio keeps the engine's sample
  rate. With no denoiser path the output is unchanged (full backward compat).
- Denoiser + native chunk streaming (`streamChunkTokens > 0`) is rejected up
  front for every engine — a stateful streaming denoiser is the follow-up. Use
  batch synthesis, or drop the denoiser for streaming.
- The tts-cpp UL-UNAS forward is implemented in
  [qvac-ext-lib-whisper.cpp#78](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/pull/78)
  (scalar CPU port, validated bit-close to the ONNX reference); it requires a
  `tts-cpp` build that includes that port — see the pinned version in `vcpkg.json`.

## Backends & GPU acceleration

The addon delegates backend selection to `tts-cpp`'s registry-only
init path.  At `load()` time the engine walks the ggml-backend registry
once and picks the first available accelerator that matches the
host's policy:

| Platform                | Default backend when `useGPU: true`          |
|-------------------------|----------------------------------------------|
| macOS / iOS             | Metal                                        |
| Linux / Windows         | Vulkan                                       |
| Android — Adreno 700+   | OpenCL                                       |
| Android — Mali / others | Vulkan                                       |
| Everything else / CPU-only build | CPU                                 |

> Both Chatterbox and Supertonic run on ARM Mali via Vulkan: `tts-cpp` sets
> `allow_arm_mali=true` for both graphs. (Earlier `tts-cpp` builds declined
> Mali for the Chatterbox / S3Gen graph and fell back to CPU there.)
>
> Parler also opts into ARM Mali Vulkan on Android. Its GPU smoke test is
> strict on Apple and Android; desktop Vulkan remains outside that test until
> dedicated Linux and Windows validation is available.
>
> CosyVoice3's GPU path covers Metal (macOS / iOS), Vulkan on desktop
> Linux / Windows, and OpenCL/Adreno (Android). `useGPU: true` /
> `nGpuLayers > 0` offloads there — on Android, pair it with
> `openclCacheDir` to persist the compiled kernels. On Android the engine
> keeps its Metal-or-OpenCL requirement, so Vulkan-only mobile GPUs
> (Mali, Xclipse) fall back to CPU rather than running a backend its
> per-stage parity gates have not covered.
>
> Audio8's GPU path covers Metal (macOS / iOS), Vulkan on desktop
> Linux / Windows, and OpenCL/Adreno (Android). `useGPU: true` /
> `nGpuLayers > 0` offloads there — on Android, pair it with
> `openclCacheDir` to persist the compiled kernels. A GPU request on a
> platform or in a build without one of those backends falls back to CPU
> and sets `response.stats.gpuUnsupported`.

### Android: dynamic backend loading

Android prebuilds enable `GGML_BACKEND_DL=ON` and ship per-arch
backend `.so` files under
`prebuilds/<bare-target>/qvac__tts-ggml/`.

The engine `dlopen()`s the highest-tier CPU variant the device's
HWCAPs support and one of the GPU `.so` files based on the policy
table above.  Hosts must pass `backendsDir: path.join(__dirname,
'prebuilds')` (or rely on the default fallback the package ships)
so the runtime knows where to look.  `openclCacheDir` is also
Android-specific; setting it to a writable path lets the OpenCL
backend persist its compiled program cache across launches.
`vulkanCacheDir` is the Vulkan analogue (Supertonic + `useGPU: true`):
setting it to a writable path persists the compiled pipeline cache
(`GGML_VK_PIPELINE_CACHE_DIR`) across launches and enables a load-time
pre-warm, so the one-time first-dispatch shader-compile cost (seconds
on Mali) is paid once per install rather than on the first `run()` of
every process.  Both are fully opt-in: unset means behaviour is
unchanged.

## Emotion & pace (cross-engine)

`emotion` and `pace` mean the same thing on every engine that supports them,
and they are set the same way: the constructor and `reload()` everywhere, plus
per call on the engines that can change them per call.  The vocabulary is owned
by tts-cpp (`include/tts-cpp/voice_controls.h`) and mirrored here; each engine
declares the subset it supports, and an unsupported value throws naming that
engine's set.

| engine | `emotion` | `pace` | per call | exact rate knob |
|---|---|---|---|---|
| Parler | all 12 | slow / moderate / fast | yes | — |
| CosyVoice3 | anger, happy, neutral, sad | slow / moderate / fast | yes | — |
| Supertonic | not supported | slow / moderate / fast | no | `speed` |
| Chatterbox | not supported | not supported | — | `speed` |
| Audio8 | not supported | not supported | — | — |

The 12 canonical emotions (case-insensitive): `command`, `anger`, `narration`,
`conversation`, `disgust`, `fear`, `happy`, `neutral`, `proper noun`, `news`,
`sad`, `surprise`.  Note `anger`, not `angry`.

```js
// identical on both emotion-capable families
const model = new TTSGgml({ files, emotion: 'happy', pace: 'slow' })
await model.load()
await model.reload({ emotion: 'sad' })          // reload
await model.run({ input: text, emotion: 'sad' }) // per call
model.runStream(text, { emotion: 'news' })       // per stream
```

`speed` is a separate, unchanged knob: an exact rate multiplier on Chatterbox
and Supertonic.  `pace` is the 3-step enum; on Supertonic the two are mutually
exclusive and setting both throws.

Two per-engine properties worth knowing:

- **CosyVoice3** is trained on one instruction per synthesis, so engaging two
  controls throws rather than silently picking a winner.  Only `pace: 'moderate'`
  engages nothing, taking the plain zero-shot path -- that path keeps the prompt
  speech tokens, where an instruction would drop them.  Every emotion, `neutral`
  included, carries its own trained instruction, so it does count as the one
  instruction and conflicts with `slow` / `fast`.
- **Supertonic** maps the step onto its duration multiplier relative to the
  GGUF's own `default_speed`, so `pace: 'moderate'` is bit-identical to setting
  nothing.  It conditions the engine when the engine is built, so its `pace`
  belongs in the constructor or `reload({ pace })`; passing one to `run()` /
  `runStream()` throws rather than being silently ignored.

## Parler descriptions

Parler is **description-conditioned**: the voice is controlled by a
natural-language caption, not a voice id.  Two mutually exclusive ways to
set it (same level = constructor or per-call; setting both throws):

- `description` (alias `voiceDescription`) — a full free-text caption.
- Template fields — `voice`, `pitch`, `expressivity`, `noise`, `reverb`,
  `quality`, plus the cross-engine `emotion` / `pace` — rendered natively in
  the models' training-caption phrasing.  All optional; with nothing set the
  models' recommended fallback caption is used, so Parler works out of the box.

```js
const model = new TTSGgml({
  files: { parlerModel: './models/parler-indic-q8_0.gguf' },
  voice: 'Rohit', // speaker name (indic: per-language voices, e.g. hi Rohit/Divya, gu Yash/Neha)
  emotion: 'happy'
})
await model.load()

// per-call override: template fields merge over the constructor's
await model.run({ input: 'आज मौसम बहुत अच्छा है।', emotion: 'sad' })
```

The indic model card lists 10 officially emotion-tested languages (Assamese,
Bengali, Bodo, Dogri, Kannada, Malayalam, Marathi, Sanskrit, Nepali, Tamil);
elsewhere — including Hindi/Gujarati and the English mini/large models —
emotion conditioning exists but is best-effort.  Per-call fields ride on
`run()` input and the `runStream`/`runStreaming` options (one description is
pinned per streaming response, keeping the native T5 cross-attention cache
hot).  Parler supports Metal GPU offload on Apple and the vendor-selected
Android GPU backend (`useGPU: true` / `nGpuLayers`), including Vulkan on ARM
Mali. Unsupported or unavailable backends fall back to CPU. It emits native
44.1 kHz.

## CosyVoice3 instruct

Beyond `emotion` / `pace` above, CosyVoice3 accepts a natural-language
instruction for the controls that have no canonical cross-engine vocabulary
yet: Chinese dialect, volume, and playful style.  Point the addon at the model
directory (auto-detected from `cosyvoice3-llm-*.gguf`) and set `instruct` —
either a raw instruction string, or a structured object with up to one control,
resolved by precedence `dialect > volume > style`:

```js
const model = new TTSGgml({
  files: { cosyvoiceModelDir: './models/cosyvoice3' },
  instruct: { dialect: 'cantonese' } // or { volume: ... } / { style: ... } / a raw string
})
await model.load()
await model.run({ input: 'Hello from an on-device C++ pipeline.' })
```

`instruct` counts toward the one-instruction rule, so combining it with
`emotion` or `pace` throws.  An unknown `instruct` key or an invalid value
throws at construction, listing the valid set; with nothing set the model runs
zero-shot on the baked voice (or a [cloned one](#cosyvoice3) — `instruct`
composes with `referenceAudio`, the instruction driving dialect/style while
the clone supplies the timbre).  Other CosyVoice3-only options: `promptText`
(the reference transcript — see Voice cloning); `streamLeftContextTokens` is
reserved / not yet effective (the pinned engine accepts but does not read it).
CosyVoice3 emits native **24 kHz** and runs on **CPU** by default; GPU offload
is opt-in via `useGPU` / `nGpuLayers` on Metal (Apple), Vulkan (desktop
Linux / Windows), and Android's OpenCL/Adreno path (`openclCacheDir` persists
its compiled-kernel cache), with other hosts falling back to CPU.

## Audio8

Audio8 is a **DualAR** model: a 24-layer autoregressive transformer picks one
semantic token per 46 ms frame, a 4-layer head fills the seven acoustic
codebooks under it, and a DAC-style neural codec turns the eight codes back
into 44.1 kHz audio.  It ships as three GGUFs because they have different
lifetimes — the language model and the codec's synthesis half run on every
synthesis, the analysis half only to enrol a voice — so a text-only
deployment can omit `files.audio8CodecEncoder` entirely.

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_AUDIO8,
  files: { modelDir: './models' },
  temperature: 0.7,
  topP: 0.9,
  opts: { stats: true }
})
await model.load()
await model.run({ input: 'Hello from a fully on-device pipeline.' })
```

Sampling is **repetition-aware**: a semantic token that repeats one from the
recent window is re-drawn under a narrower nucleus at a higher temperature,
which is what keeps the model out of the babble attractor that pure top-p
falls into.  `greedy: true` takes the argmax instead and ignores
`temperature` / `topK` / `topP`; it is reproducible but noticeably flatter.
`maxFrames` caps generation in codec frames (~21.5/s of audio).

Audio8 runs on CPU by default. Set `config.useGPU: true` or `nGpuLayers: 99`
to offload the language model and codec graphs to Metal (macOS / iOS), Vulkan
(desktop Linux / Windows) or OpenCL (Android / Adreno). If none of those is
available, the engine falls back to CPU and sets
`response.stats.gpuUnsupported`. Voice cloning uses the same backend and adds
a one-off encode when a new reference recording is supplied.

## API overview

### Constructor — `new TTSGgml(options)`

| Option                    | Type       | Default    | Notes |
|---------------------------|------------|------------|-------|
| `files.modelDir`          | string     | —          | Dir containing the engine GGUFs (engine auto-detected from the filenames present) |
| `files.t3Model`           | string     | —          | Overrides `modelDir` for T3 |
| `files.s3genModel`        | string     | —          | Overrides `modelDir` for S3Gen |
| `files.supertonicModel`   | string     | —          | Supertonic GGUF (overrides `modelDir`) |
| `files.parlerModel`       | string     | —          | Parler GGUF — mini/large/indic variant (overrides `modelDir`) |
| `files.cosyvoiceModelDir` | string     | —          | CosyVoice3 model directory (`cosyvoice3-{llm,flow,hift}-*.gguf` + `voice.gguf` + `vocab.json` + `merges.txt`, plus the cloning add-on GGUFs when cloning); routes to CosyVoice3 |
| `files.cosyvoiceS3tokModel` | string   | —          | CosyVoice3 speech_tokenizer_v3 GGUF; needed only with `referenceAudio` (auto-discovered in the model dir as `cosyvoice3-s3tok-*.gguf`) |
| `files.cosyvoiceCampplusModel` | string | —         | CosyVoice3 CAM++ speaker-encoder GGUF; needed only with `referenceAudio` (auto-discovered as `cosyvoice3-campplus-*.gguf`) |
| `files.cosyvoiceLlmModelPath` / `cosyvoiceFlowModelPath` / `cosyvoiceHiftModelPath` | string | — | Per-component overrides for the CosyVoice3 model dir |
| `files.audio8Lm`          | string     | —          | Audio8 DualAR language model GGUF (overrides `modelDir`) |
| `files.audio8CodecDecoder`| string     | —          | Audio8 codec synthesis half — codes to wav (overrides `modelDir`) |
| `files.audio8CodecEncoder`| string     | —          | Audio8 codec analysis half — wav to codes; only needed to clone a voice |
| `files.lavasrEnhancer`    | string     | —          | LavaSR enhancer GGUF — supplying it turns on 48 kHz enhancement |
| `files.lavasrDenoiser`    | string     | —          | LavaSR denoiser GGUF — supplying it turns on denoising (batch only) |
| `engine`                  | string     | auto       | Force `'chatterbox'`, `'supertonic'`, `'cosyvoice3'`, `'parler'` or `'audio8'` (`TTSGgml.ENGINE_CHATTERBOX` / `ENGINE_SUPERTONIC` / `ENGINE_COSYVOICE3` / `ENGINE_PARLER` / `ENGINE_AUDIO8`); auto-detected from the GGUFs present otherwise |
| `referenceAudio`          | string     | —          | Wav to clone (Chatterbox: mono, ≥ 5 s; CosyVoice3: 0.5-30 s, multichannel downmixed to mono, needs the s3tok + campplus GGUFs; Audio8: also needs `referenceText`).  Audio8 accepts it per call too |
| `referenceText`           | string     | —          | Audio8-only: what `referenceAudio` says, verbatim.  Required whenever a reference is set; accepted per call |
| `voiceDir`                | string     | —          | Pre-baked voice profile |
| `seed`                    | number     | 42         | RNG seed (CFM noise + sampling) |
| `nGpuLayers`              | number     | 0          | Layers offloaded to GPU (mirrors `useGPU`; pass `99` to offload all) |
| `nCtx`                    | number     | 4096       | Chatterbox T3 context limit for the prompt plus generated speech tokens (25 tokens ≈ 1 s of audio). The KV cache is allocated up front at this length, so the 4096-token default directly bounds memory. Pass `0` to use the GGUF metadata value |
| `kvCacheType`             | string     | `f16`      | T3 KV-cache dtype: `f32` \| `f16` \| `q8_0`.  `f16` (~50% of f32) is the safe cross-backend default.  `q8_0` stores the cache at ~27% of f32 and decodes 20-30% faster on Metal, but only works on backends with a q8_0 CONT op (CPU, CUDA) — it hard-aborts the multilingual model on Metal, so it is opt-in.  Turbo greedy decoding is byte-identical across all three (upstream-validated).  Pass `f32` for bit-exact pre-quantisation behaviour |
| `threads`                 | number     | hw.concurrency capped at 4 | |
| `streamChunkTokens`       | number     | 0          | **>0 enables native chunk streaming** |
| `streamFirstChunkTokens`  | number     | = streamChunkTokens | Smaller first chunk for low first-audio-out |
| `cfmSteps`                | number     | 2          | Chatterbox: 1 = faster (halved CFM cost) |
| `speed`                   | number     | 1.0        | Speaking-rate multiplier, bounded `[0.25, 4.0]` (`< 1` slower, `> 1` faster). Both engines |
| `voice` / `voiceName`     | string     | —          | Supertonic voice id (e.g. `'F1'`, `'M1'`); Parler template speaker name (e.g. `'Laura'`, `'Rohit'`) |
| `steps` / `numInferenceSteps` | number | GGUF default | Supertonic vector-estimator CFM steps (`0` = GGUF default) |
| `noiseNpyPath`            | string     | —          | Supertonic: optional fixed CFM noise `.npy` for reproducibility |
| `description` / `voiceDescription` | string | fallback caption | Parler-only: full free-text voice description (mutually exclusive with the template fields) |
| `emotion`, `pace`        | string     | —          | Cross-engine conditioning (see [Emotion & pace](#emotion--pace-cross-engine)); an unsupported value errors listing what that engine supports |
| `pitch`, `expressivity`, `noise`, `reverb`, `quality` | string | — | Parler-only template fields (see [Parler descriptions](#parler-descriptions)); invalid values error listing the valid set |
| `temperature` / `topK` / `topP` | number | engine defaults | Parler + Audio8 sampling knobs (omit for the engine's own defaults — Parler temp 1.0 / top-k 50, Audio8 temp 0.7 / top-k 50 / top-p 0.9; `topP` in `(0, 1]`) |
| `maxFrames`               | number     | engine max | Parler + Audio8 generation cap in frames (Parler ~86/s of audio, Audio8 ~21.5/s); `0` = model default, Parler rejects 1–9 |
| `greedy`                  | boolean    | `false`    | Audio8-only: take the argmax instead of sampling; ignores `temperature` / `topK` / `topP` |
| `minNewTokens`            | number     | GGUF default | Parler-only minimum tokens before EOS (`-1` = model default) |
| `normalizeNumbers`        | boolean    | `true`     | Parler-only: expand digits before tokenization (English words; script-native digits on indic) — parler voices raw digits badly |
| `instruct`                | object \| string | —    | CosyVoice3-only: instruction controls (`dialect` / `volume` / `style`, resolved by precedence in that order) or a raw instruction string; an unknown key or invalid value throws, and it counts toward the one-instruction rule (see [CosyVoice3 instruct](#cosyvoice3-instruct)) |
| `promptText`              | string     | —          | CosyVoice3-only: verbatim transcript of `referenceAudio` — set for zero-shot cloning, omit for cross-lingual; without a reference it overrides the baked voice's transcript |
| `streamLeftContextTokens` | number     | —          | CosyVoice3-only: intended native chunk-streaming left-context tokens. Reserved / not yet effective — the pinned engine accepts but does not read it |
| `mecabDictDir`            | string     | —          | Chatterbox MTL Japanese (`ja`): compiled MeCab/IPAdic dictionary directory |
| `cangjieTsvPath`          | string     | —          | Chatterbox MTL Chinese (`zh`): `Cangjie5_TC` TSV path |
| `backendsDir`             | string     | `path.join(__dirname, 'prebuilds')` | Root dir the addon scans for dynamically-loaded ggml backend `.so` files.  Required on Android (host should pass `path.join(__dirname, 'prebuilds')`); ignored on platforms that statically link the backend |
| `openclCacheDir`          | string     | unset      | Android-only: directory where the OpenCL backend persists its compiled program-binary cache.  Setting it across runs avoids re-JITing the kernels on every fresh process |
| `vulkanCacheDir`          | string     | unset      | Supertonic + `useGPU: true` only: writable directory where the Vulkan backend persists its compiled pipeline cache (`GGML_VK_PIPELINE_CACHE_DIR`).  Moves the one-time first-dispatch pipeline-compile cost (seconds on Mali) off the first `run()` — paid once per install instead of once per process — and enables a load-time pre-warm.  Fully opt-in: unset -> no cross-process cache, no pre-warm, behaviour unchanged |
| `config.language`         | string     | `"en"`     | Chatterbox MTL accepts `es/fr/de/pt/it/zh/ja/ko/...`; turbo & Supertonic are English |
| `config.useGPU`           | boolean    | `false`    | Set to `true` to route through Metal / Vulkan / CUDA / OpenCL if available. Honored for Chatterbox/Supertonic on GPU-capable hosts (including Android, per `tts-cpp`'s per-vendor allowlist); Parler is validated on Apple/Metal and Android/ARM Mali Vulkan; CosyVoice3 offloads on Apple/Metal, desktop Linux/Windows Vulkan, and Android OpenCL/Adreno; Audio8 uses desktop Vulkan on Linux/Windows. Unsupported backends fall back to CPU. See [Backends & GPU acceleration](#backends--gpu-acceleration) |
| `config.outputSampleRate` | number     | — (engine-native) | Resample the output to this rate (8000–192000 Hz). Omit to keep the engine-native rate (Chatterbox 24 kHz, Supertonic / Parler / Audio8 44.1 kHz, CosyVoice3 24 kHz, enhancer 48 kHz). Parler native chunk streaming accepts a non-native rate only with the enhancer active |
| `opts.stats`              | boolean    | `false`    | Populate `response.stats` with RTF, `backendDevice` (0=CPU, 1=GPU), `backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other), and — when an enhancer is active — `enhancerBackendDevice` / `enhancerBackendId` |
| `exclusiveRun`            | boolean    | `false`    | **Top-level** option (not under `opts`): serialize overlapping streaming runs |

### Methods

- `await model.load()` — construct the native engine (loads T3, preloads
  S3Gen, bakes voice conditioning).  Subsequent `run()` calls reuse all
  of it.
- `await model.unload()` — release everything.  Idempotent.
- `await model.reload(newConfig)` — re-create the engine with a new
  config (`language`, `useGPU`, `outputSampleRate`, …).
- `await model.destroy()` — `unload()` + mark this instance dead.
- `await model.cancel()` — best-effort cancel of any in-flight run.
- `model.run({ input, type: 'text' })` → `QvacResponse`.
- `model.run({ input, streamOutput: true })` → sentence-chunked
  synthesis driven by the JS-side sentence splitter (see
  `lib/textChunker.js`).  Equivalent to `runStream(input)`.
- `model.run({ input, signal })` → pass an `AbortSignal` to cancel a
  **non-streaming** run: when the signal aborts, `response.await()` rejects
  with the abort reason.  An already-aborted signal rejects deterministically
  without dispatching the engine (no native interrupt).  **Ignored when
  `streamOutput: true`** (and on `runStream` / `runStreaming`) — the streaming
  path does not thread the signal, so passing it there is a silent no-op.
- `model.runStream(text, { locale?, maxChunkScalars? })` → same as
  above, but the options read more naturally for the "split this long
  string" use case.
- `model.runStreaming(textStream, opts)` → streaming input + streaming
  output. `opts` accepts `accumulateSentences`, `sentenceDelimiter`,
  `sentenceDelimiterPreset`, `maxBufferScalars`, `flushAfterMs`, Parler
  description fields, and Audio8 reference fields (see
  [Sentence streaming](#sentence-streaming--runstreamingasynciter)).

### Response shape

All `run*` methods return a `QvacResponse` (from `@qvac/infer-base`):

```js
response.onUpdate(data => {
  data.outputArray   // Int16Array — mono PCM
  data.sampleRate    // actual rate: Chatterbox 24000, Supertonic/Parler/Audio8 44100, enhancer 48000
  data.chunkIndex    // present on sentence-streaming events only
  data.sentenceChunk // present on sentence-streaming events only
})
await response.await()

// response.stats — only when constructor had `opts: { stats: true }`
response.stats.totalTime         // seconds
response.stats.realTimeFactor    // synthesis time / audio duration
response.stats.audioDurationMs
response.stats.totalSamples
response.stats.tokensPerSecond   // Audio8 counts codec frames, the others characters
response.stats.generatedFrames   // Audio8 only: codec frames, on a fixed 46 ms grid
response.stats.backendDevice     // 0=CPU, 1=GPU
response.stats.backendId         // 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other
// present when a LavaSR enhancer is active:
response.stats.enhancerBackendDevice // -1 none, 0 CPU, 1 GPU
response.stats.enhancerBackendId
```

### Text helpers

The sentence splitter is available from
`@qvac/tts-ggml/text-chunker` as `splitTtsText`. The incremental sentence
buffer is available from `@qvac/tts-ggml/text-stream-accumulator` as
`accumulateTextStream`. The existing
`@qvac/tts-ggml/lib/textStreamAccumulator.js` deep path remains supported.

### Errors

`QvacErrorAddonTTSGgml` and `ERR_CODES` are exported from the package root:

```js
const {
  QvacErrorAddonTTSGgml,
  ERR_CODES
} = require('@qvac/tts-ggml')
```

| Code | Name |
|---:|---|
| 13001 | `FAILED_TO_ACTIVATE` |
| 13002 | `FAILED_TO_APPEND` |
| 13003 | `FAILED_TO_GET_STATUS` |
| 13004 | `FAILED_TO_PAUSE` |
| 13005 | `FAILED_TO_CANCEL` |
| 13006 | `FAILED_TO_DESTROY` |
| 13007 | `FAILED_TO_UNLOAD` |
| 13008 | `FAILED_TO_LOAD` |
| 13009 | `FAILED_TO_RELOAD` |
| 13010 | `FAILED_TO_STOP` |
| 13011 | `JOB_ALREADY_RUNNING` |

## Examples

Runnable demos under `examples/`:

| Script | Demonstrates |
|---|---|
| `chatterbox-tts.js` | Batch synth + wav dump. `bare examples/chatterbox-tts.js "Hello"` |
| `chatterbox-mtl-tts.js` | Multilingual Chatterbox synthesis |
| `chatterbox-mtl-sweep-tts.js` | Multilingual Chatterbox sweep across languages |
| `chatterbox-adjust-speed.js` | Speaking-rate (`speed`) control |
| `chatterbox-sentence-stream-tts.js` | `runStreaming()` over an async iterator of sentences, with gapless streaming playback |
| `chatterbox-chunk-stream-tts.js` | Native per-chunk PCM streaming via `streamChunkTokens`, with gapless streaming playback |
| `chatterbox-enhanced.js` | Chatterbox + LavaSR 48 kHz enhancement (batch). `bare examples/chatterbox-enhanced.js "Hello"` |
| `supertonic-tts.js` | Supertonic batch synth. `bare examples/supertonic-tts.js "Hello"` |
| `supertonic-mtl-tts.js` | Multilingual Supertonic synthesis |
| `supertonic-mtl-sweep-tts.js` | Multilingual Supertonic sweep across languages |
| `supertonic-sentence-stream-tts.js` | Supertonic sentence-level streaming |
| `supertonic-enhanced.js` | Supertonic + LavaSR 48 kHz enhancement. `bare examples/supertonic-enhanced.js "Hello"` |
| `parler-tts.js` | Parler batch synth with voice/emotion templates. `bare examples/parler-tts.js "Hello" Laura happy` |
| `parler-enhanced.js` | Parler + LavaSR 48 kHz enhancement. `bare examples/parler-enhanced.js "Hello" Laura happy` |
| `cosyvoice-tts.js` | CosyVoice3 batch synth with the cross-engine emotion option (24 kHz; CPU by default, `--gpu` opts into Metal / desktop Vulkan / Android GPU). `bare examples/cosyvoice-tts.js --gpu "Hello" happy` |
| `cosyvoice-enhanced.js` | CosyVoice3 + LavaSR 48 kHz enhancement (add `--denoise` for the denoiser). `bare examples/cosyvoice-enhanced.js "Hello"` |
| `audio8-tts.js` | Audio8 batch synth, optionally cloning a reference. Set `QVAC_TTS_AUDIO8_GPU=1` for desktop Vulkan. `bare examples/audio8-tts.js "Hello" voice.wav "What it says."` |

The two streaming examples feed PCM into a single long-running
`sox play` / `ffplay` process so chunks play back-to-back without any
per-chunk spawn gaps — install one of them (`brew install sox` or
`brew install ffmpeg` on macOS) to enable playback.  Absent a player
the demos still run and write the concatenated wav.

## Testing

```bash
npm run test:unit          # mocked binding; fast
npm run test:integration   # spins up the real engine; needs models
npm run test               # both
```

Integration tests scan a few candidate `models/` directories for the
required GGUFs (see `test/utils/downloadModel.js`) and skip cleanly when
files are absent.  They cover, across the engines:

* batch synthesis with full RuntimeStats,
* sentence-level streaming (`runStream` / `run({ streamOutput: true })`
  / `runStreaming` over async iterators),
* native sub-sentence chunk streaming (Chatterbox-only via
  `streamChunkTokens`),
* sequential-run / fresh-instance / reload-stability behaviour,
* strict GPU-backend assertion via `response.stats.backendDevice` +
  `backendId` (set `NO_GPU=true` to skip on CPU-only runners,
  `QVAC_TTS_GPU_SMOKE_RELAX=1` to downgrade the strict gate to a
  warning),
* multilingual Chatterbox sweep (es/fr/de/pt) via `chatterbox-mtl.test.js`,
* on darwin the Chatterbox English batch path is additionally verified
  for WER against the synthesized audio (whisper-small via the
  `@qvac/asr-ggml` development dependency).

To stress-test long inputs, set `INPUT_SENTENCES=medium` (or `long`)
and re-run the integration suite — `addon.test.js` reads the env var to
pick its sentence corpus from `test/data/sentences-{medium,long}.js`.

## Build from source

Prerequisites: `clang` with C++20 support, CMake ≥ 3.25,
[vcpkg](https://vcpkg.io/) (set `VCPKG_ROOT`), `bare-make`.

```bash
npm install
npx bare-make generate      # configures + fetches the tts-cpp port
npx bare-make build
npx bare-make install       # copies the .bare into prebuilds/<triple>/
```

The vcpkg port is hosted in
[`tetherto/qvac-registry-vcpkg`][registry] and pulls
[`qvac-tts.cpp`][qvac-tts-cpp] at a pinned REF.  See
[`vcpkg-configuration.json`](./vcpkg-configuration.json) for the
baseline commit.

GPU backends are controlled by the `tts-cpp` port's vcpkg features:
`metal` (default on osx/ios), `vulkan` (default on
linux/windows/android), `opencl` (default on android).
On Android the port is configured with
`GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON`, so the build
produces per-arch CPU + Vulkan + OpenCL `.so` files alongside the
`.bare` module instead of statically linking; the resulting prebuilds
layout is what the `backendsDir` option expects (see
[Backends & GPU acceleration](#backends--gpu-acceleration)).

[registry]: https://github.com/tetherto/qvac-registry-vcpkg

## Troubleshooting

**`t3 model not found` / `supertonic model not found`** — the paths in
`files` are wrong or the GGUFs weren't generated.  Run
`npm run setup-models` (creates the Python venv and converts the
upstream checkpoints into the four / five expected GGUF files).

**`VoiceEncoder forward failed`** when passing `referenceAudio`** —
the reference wav is likely < 5 s of clean speech.  Make it longer
(10–15 s gives the best similarity).

**Slower-than-expected RTF on darwin** — set `config: { useGPU: true }`
(the default is now CPU; see [Constructor](#constructor--new-ttsggmloptions)
+ [Backends & GPU acceleration](#backends--gpu-acceleration)) and
confirm the port was built with the `metal` feature.  Also confirm
your reference wav's mel was baked (`Using C++ VoiceEncoder` /
`C++ S3TokenizerV2` messages in the log) — if voice conditioning
falls back to CPU, a chunk of the first-call overhead is visible in
RTF.

**Slow-but-otherwise-fine RTF on Android** — set `config: { useGPU:
true }` (the default is CPU; see
[Backends & GPU acceleration](#backends--gpu-acceleration)) and confirm
your device's GPU is on `tts-cpp`'s per-vendor allowlist.  Both Chatterbox
and Supertonic run on the GPU on Adreno, Xclipse, and Mali (Adreno uses
OpenCL; Xclipse and Mali use Vulkan).

## License

Apache-2.0.  See [LICENSE](./LICENSE).
