# Model sources and generated constants

Model source schemas live under `src/schemas/`; generated registry constants live
under `src/models/registry/`. The SDK re-exports the inference model registry.

- Accept only source shapes represented by the public schema.
- Preserve descriptor metadata needed for multi-file and sharded models while
  maintaining compatibility with supported string sources.
- Regenerate model constants through the package script; never edit generated files
  by hand.
- Update source normalization, load/download schemas, handlers, generated outputs,
  and focused tests together when the source contract changes.
- Use the live registry input and generator as the authority for names and metadata;
  do not maintain a hand-written model inventory in documentation.

A model descriptor's `engine` identifies its canonical plugin, independently of
which addon package implements it. Multiple plugins can share an addon without
making their model descriptors interchangeable. Explicit `modelType` selection
must match the descriptor's engine. Legacy package-valued engines remain supported
for compatibility, but package identity cannot distinguish capabilities that share
an addon.

Registry submissions, live queries, and the generated catalog must agree on the
canonical engine. Use `resolveRegistryEngine` for registry metadata; it preserves
recognized legacy package IDs and their discriminator tags. Canonical engine
identity takes precedence over tags. A shared package ID without an unambiguous
legacy rule stays unresolved. Submission validation reads the supported engines
and these rules from a manifest inside the registry package, generated from the
same canonical definitions as the SDK contract.
Sync corrected registry metadata before clients rely on registry-returned
descriptors, and coordinate rollout with clients that recognize the engine.
Regenerate the catalog and downstream clients from the corrected metadata; do not
patch generated constants or bypass model-type validation.

On macOS and iOS, a registry GGUF can pair with a compiled Apple Core ML bundle
that the native addon runs a stage on when it sits next to the GGUF; the pairs
are listed in `src/handlers/load-model/coreml-sidecars.ts`. The registry
publishes each `.mlmodelc` component as its own file, and the catalog keeps them
as companion-only entries, never as model constants. The resolver discovers a
complete bundle and downloads it with the GGUF, preserving the directory layout
the addon expects. Without a complete bundle, and on every other platform, the
GGUF loads on its own.

## CosyVoice3 companion sets

Load the lighter set with `TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` as `modelSrc`,
`modelType: 'tts-ggml'`, and `modelConfig: { ttsEngine: 'cosyvoice3' }`.
The generated catalog pairs the Q4 LLM with Q4 flow and F16 HiFT weights.
It reuses the compatible original tokenizer (`vocab.json`, `merges.txt`) and
English baked voice across registry directories. The resolver downloads and
checksum-validates all six artifacts into one companion cache directory,
renaming `voice-en.gguf` to `voice.gguf` for native discovery. No manual file
placement is needed. Missing required files prevent companion-set generation;
other releases and registry sources cannot silently supply replacements.

The existing `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` set keeps its Q8 LLM, F32 flow,
and F32 HiFT weights and its separate cache directory.

The registry sizes, including tokenizer and voice assets, are:

| Set                          |   Total bytes |   GiB |
| ---------------------------- | ------------: | ----: |
| Q4 LLM / Q4 flow / F16 HiFT  | 1,057,658,782 | 0.985 |
| Q8 LLM / F32 flow / F32 HiFT | 2,394,799,678 | 2.230 |
| Savings                      | 1,337,140,896 | 1.245 |

The lighter set reduces download size by **55.84%**. These are artifact bytes;
P2P protocol overhead and disk allocation are excluded.

Run the real registry and native synthesis regression on a desktop with a GPU:

```sh
npm run build:test
QVAC_TEST_COSYVOICE=1 npx brittle-bare test/dist/test/cosyvoice3-registry.integration.test.js
```

This loads both generated model constants without staged files, checks the
six-file cache layout, and tests 24 kHz batch synthesis and native token-chunk
streaming. Streaming must emit multiple non-silent, finite PCM chunks from one
unsplit sentence. The temporary validation cache is reused between runs.
