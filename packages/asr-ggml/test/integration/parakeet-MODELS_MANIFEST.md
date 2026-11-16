# Integration model manifest

`models.manifest.json` is the single source of truth for every model asr-ggml's
CI stages, in the package CI contract's schema (`docs/ci/workflow-standard.md`).
It holds both engines and the Core ML sidecars:

- Parakeet GGUFs: `s3Path` entries, staged from `s3://$MODEL_S3_BUCKET/<s3Path>`.
- Whisper models: `urls` entries, pinned to a Hugging Face revision.
- Core ML encoder sidecars: the top-level `sidecars` object, which the CI
  contract's model download ignores.

Each entry's `targets` names the CI targets that stage it, and `dest` where it
lands. The contract's jobs fetch the entries of their target before running it,
and key the model cache on the whole file. The package's own tools read the same
file and skip the entries that are not theirs:

- `scripts/stage-integration-models.mjs` stages the `s3Path` entries and, on
  darwin, the sidecars.
- `scripts/stage-whisper-models.mjs` stages the `urls` entries.
- `scripts/generate-model-manifest.mjs` pins the `s3Path` entries.

Keep the JSON manifest limited to fields that must affect the cache key.
Documentation belongs in this file so wording-only changes do not evict the
multi-gigabyte model cache. Increment `cacheEpoch` to force an explicit cache
eviction.

The `bytes` and `sha256` fields pin every staged object. Staging verifies cached
and freshly downloaded files and rejects mismatches. After replacing an S3
object or changing the staged set, stage the complete model set and run:

```sh
npm run generate-model-manifest
```

Running the generator with `--check` rejects missing or mismatched pins for
every locally present model.

The S3 date prefixes mirror the registry prefixes in `parakeet-helpers.js`
`MODEL_CONFIGS`. The Sortformer Streaming v2.1 q8_0 model is included so
`parakeet-sortformer-aosc-streaming.test.js` resolves it locally instead of downloading
it during the test timeout. Mobile q4_0/f16 streaming models are provisioned
separately by the mobile model manifest.

Indic Conformer CTC q8_0 (`indic_conformer/2026-08-07`) is staged for desktop
integration (`parakeet-addon-multimodel.test.js`); mobile uses q4_0 via
`scripts/generate-mobile-model-manifest.js`.

The C++ tests take `ggml-tiny.bin`, `ggml-silero-v5.1.2.bin` and
`sortformer-4spk-v1.q4_0.gguf`, so those entries list `cpp:tests` too.
