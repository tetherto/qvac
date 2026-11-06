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

Diffusion and video `modelConfig.performance_profile` delegates hardware selection
to the diffusion addon. `off` retains baseline settings. Explicit
`flash_attn`, `vae_conv_direct`, and `tensor_type_rules` settings take precedence.
These controls require an addon release containing performance profiles.
Temporal tiling remains unchanged: full-temporal decoding is already the native
default, and an explicit `temporal_tiling` setting is preserved.

LTX's automatic Metal F16 profile needs declared output limits:
`performance_max_width: 512`, `performance_max_height: 320`, and
`performance_max_frames: 97`. Declare all three together. The addon rejects
requests above these limits and selects F16 only for a validated model/device
with sufficient free memory. Unbounded contexts retain their current precision.
The SDK forwards these controls; it does not duplicate the hardware policy.
For bounded video contexts, load-time fit checks and `assessModelFit` assess the
declared maximum width, height and frame count. Unbounded video uses the existing
33-frame fit workload.

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
duration is required for native fit evidence; omitted workloads remain unknown.
The projection uses the same GPU/thread settings as the load, and uses registry
descriptions or local files without reading full weights into memory.

Nemotron 3 Diarization uses `parakeet-transcription` with a single local GGUF.
Offline metadata retains overlapping `speakerSegments`; streaming segment and
speaker-activity VAD events retain `speakerId`. `diarizationThreshold` and
`diarizationMinSegmentMs` are load-time controls and per-call streaming controls.
Omitted controls preserve native model defaults. Registry constants and model-output
validation are pending registry weights.

TranscribePsy-250M-EU-sub (`PARAKEET_TRANSCRIBEPSY_250M_Q8_0`) loads through
`parakeet-transcription` as a TDT model; it detects its eight European languages
itself. `longFormWindowFrames` and `longFormContextFrames` bound the offline
encoder window on long recordings in 80 ms encoder frames; the default `0` takes
the window the model recommends (60 s with 25 % overlap for TranscribePsy). Its
Core ML distribution, `PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`, is an
encoder-less GGUF whose encoder and decoder bundles the loader stages beside it on
macOS and iOS; on any other platform that load is refused before the download.
