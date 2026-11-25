# Configuration

The configuration schema lives in `src/schemas/config.ts`; resolution and runtime
state live in their neighboring configuration and runtime modules. The SDK consumes
the exported inference surface rather than maintaining an independent schema.

- Resolve and validate configuration before exposing it to handlers.
- Keep runtime configuration immutable unless a public API explicitly defines a
  reload operation.
- Add a field to its schema, resolved state, public type surface, and focused tests
  together.
- Use cross-platform path and environment handling compatible with Bare and the SDK
  hosts.
- Never put credentials or machine-specific values in committed defaults or
  examples.

Read the current source before documenting defaults; configuration fields and
defaults are intentionally not duplicated here.

The diffusion addon selects the performance profile. See the
[diffusion config schema](../src/schemas/sdcpp-config.ts) for defaults and
overrides and the [video generation guide](../../../docs/website/content/_unpublished/sdk/next/ai-capabilities/video-generation.mdx#performance-profiles)
for supported hardware and LTX output limits.

Load-time fit checks and `assessModelFit` size bounded video at its declared
maximum width, height, and frame count. If any limit exceeds what the
[fitter](../src/plugins/builtin/sdcpp-generation/fit.ts) can size, the fit is
`unknown`.

`includeAudioDecoder` is a bundle-time option consumed by the SDK. Set it to
`false` for workers that only process raw PCM or streaming audio, and list the
required plugins explicitly. `audiogen-ggml` can also produce PCM or WAV without
FFmpeg. Compressed audio file decoding and compressed audiogen output formats
require `bare-ffmpeg` to be bundled.

Decoded audio input streams consume PCM updates without retaining a second
history in the decoder response. The decoder still buffers the encoded input,
and downstream stream queues can retain decoded PCM.

MOSS transcription uses the `moss-transcribe` model type and plugin. It supports
batch transcription, with optional `maxThreads`, `useGPU` (Metal), and
`backendsDir` model configuration. Per-request `hotwords` or `prompt` and
`maxNewTokens` belong to `transcribe`, not model configuration. Metadata results
include timestamps and optional `speakerId` / `speaker` labels. Streaming,
and CoreML sidecars are not exposed by this plugin. `assessModelFit` accepts
a MOSS candidate with `transcriptionWorkload: { audioSeconds, prompt?, hotwords?,
maxNewTokens? }`, separate from `modelConfig`. An explicit positive recording
duration is required for a verdict; omitted workloads remain unknown.
The projection uses the same GPU/thread settings as the load, and uses registry
descriptions or local files without reading full weights into memory.

Nemotron 3 Diarization uses `parakeet-transcription` with a single local GGUF.
Offline metadata retains overlapping `speakerSegments`; streaming segment and
speaker-activity VAD events retain `speakerId`. `diarizationThreshold` and
`diarizationMinSegmentMs` are load-time controls and per-call streaming controls.
Omitted controls preserve native model defaults. Registry constants and model-output
validation are pending registry weights.

Parakeet loads take an explicit native `backend` selector (`auto`, `cpu`, `cuda`,
`vulkan`, `opencl`, `metal`, or an exact ggml device name), which overrides `useGPU`
and reaches the fit request. `speakerAttribution` adds a separate diarization
model, given as a `modelSrc` the plugin resolves into the
`speakerAttributionModelPath` artifact, for batch text-per-speaker transcription;
it is refused with `streaming`, left out of config reloads, and makes the fit
verdict `unknown` because the fitter projects one model. Parakeet streaming
segments and events keep the native `tokenIds`, `isFinal`, `chunkIndex`,
`eotConfidence`, end-of-turn `timestamp`/`confidence` and VAD `chunkIndex`.

Omit both the load-time `streamingChunkMs` and the per-call
`parakeetStreamingConfig.chunkMs` to use the model's native decode window.
Omitting only the per-call value inherits an explicit load-time override.
Offline TDT push streams, including Parakeet TDT v3, default to 30,000 ms and
require at least 30,000 ms. Explicit SDK overrides must be positive. Full
TranscribePsy EU uses its own default.

With ASR 0.13 or later, standard TDT transcription falls back to ggml when a
Core ML sidecar cannot safely handle the encoder input. Leave that decision to
the native engine for batch and push-stream transcription. ASR 0.13.1 also
isolates valid encoder frames from right-padding; the inference package requires
ASR 0.13.2 or later. A streaming decode
window is independent of the size of PCM writes: callers can send small writes
while the engine accumulates its supported window. Unsupported explicit TDT
windows fail through the normal request error path instead of producing a
truncated transcript.

TranscribePsy-250M-EU-sub (`PARAKEET_TRANSCRIBEPSY_250M_Q8_0`) loads through
`parakeet-transcription` as a TDT model; it detects its eight European languages
itself. The full TranscribePsy-250M-EU (`PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`,
25 European languages) loads the same way from one GGUF that embeds its CAFE
adapters and language gate; `language` selects `en` (English trunk), `other`
(non-English adapters) or `auto` (the gate routes the recording; also the default
when omitted). It runs on ggml only: the EU-sub Core ML bundles do not contain its
adapters. `longFormWindowFrames` and `longFormContextFrames` bound the offline
encoder window on long recordings in 80 ms encoder frames; the default `0` takes
the window the model recommends (60 s with 25 % overlap for TranscribePsy). Its
Core ML distribution, `PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`, is an
encoder-less GGUF whose encoder and decoder bundles the loader stages beside it on
macOS and iOS; on any other platform that load is refused before the download.

Image diffusion (`sdcpp-generation`, `mode: 'diffusion'`) takes optional Apple
Core ML sidecars for SD 1.x/2.x models, SDXS included: `coremlUnetModelSrc` (the
UNet) and `coremlTaeDecoderModelSrc` (the tiny-autoencoder decoder), plus
`taesdModelSrc` (TAESD weights that replace the full VAE on every platform). The
plugin resolves them into the `coremlUnetModelPath`, `coremlTaeDecoderModelPath`
and `taesdModelPath` artifacts, which become the addon's `files.coremlUnet`,
`files.coremlTaeDecoder` and `files.taesd`. A sidecar source is a local
`.mlmodelc` directory or a `registry://` address of one: the registry loader
stages every component under the bundle directory, from the catalog's listing,
the listing saved by an earlier download, or the live registry's, and returns the
directory. HTTP and `pear://` sidecar sources, the sidecars off macOS and iOS,
and all three sources outside image diffusion are refused before any download.
The plugin never sets `prediction`, which belongs to the UNet export (`'eps'` for
the SD 2.1-base sidecar on SD 2.1). A diffusion request with a `lora` is refused
on a Core ML UNet, and a load with either sidecar gets an `unknown` fit verdict
without running the fitter. `SD_COREML_COMPUTE_UNITS` (`cpu_ne`, `all`,
`cpu_gpu`, `cpu`) is a process-wide environment variable the engine reads at load
time; it has no per-load config field.
