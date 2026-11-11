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
