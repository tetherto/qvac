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
