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

## Pocket TTS

Use `modelType: 'tts-ggml'` with `modelConfig.ttsEngine: 'pocket'`. The primary
`modelSrc` is the converted FlowLM GGUF; `mimiModelSrc` and `frontendSrc` provide
the companion model and tokenizer. Supply exactly one of `voiceSrc` (prepared
voice GGUF) or `referenceAudioSrc` (WAV, requiring a checkpoint with a working
Mimi encoder). All sources use the normal model-source resolver and cache.

Pocket is English and CPU only. Its strict configuration rejects controls for
other engines rather than silently ignoring them. Sampling controls are
load-time settings. Explicit `steps: 4` mitigated the reported one-step artifact
in our listening comparison; omitting it preserves the native one-step default.
See the [SDK example](../../sdk/docs/pocket-tts.md) and
[native validation and quality evidence](../../tts-ggml/docs/pocket-tts.md).
