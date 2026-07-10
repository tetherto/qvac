# Integration model manifest

`models.manifest.json` is the single source of truth for the
transcription-parakeet desktop integration model set. It is consumed by:

- `scripts/stage-integration-models.mjs`, which stages each model from
  `s3://$MODEL_S3_BUCKET/<s3Path>`.
- `.github/actions/cache-models`, which hashes the complete manifest to derive
  the model-cache key.

Keep the JSON manifest limited to fields that must affect the cache key:
`cacheEpoch`, `source`, and `models`. Documentation belongs in this file so
wording-only changes do not evict the multi-gigabyte model cache.

Parakeet models come from S3 rather than Hugging Face, so the `cache-models`
warm step is disabled. Changing a model name or `s3Path` updates both the
staging set and cache key. Increment `cacheEpoch` to force an explicit cache
eviction.

The `bytes` and `sha256` fields pin every staged object. Staging verifies cached
and freshly downloaded files and rejects mismatches. After replacing an S3
object or changing the staged set, stage the complete model set and run:

```sh
npm run generate-model-manifest
```

Alternatively, dispatch `integration-test-transcription-parakeet.yml` with
`pin_model_manifest: true`. The dedicated job restores the shared model cache,
stages the complete S3 set, generates and checks the pins, then uploads the
manifest as `transcription-parakeet-model-manifest`. Review and commit that
artifact. Running the generator with `--check` rejects missing or mismatched
pins for every locally present model.

The S3 date prefixes mirror the registry prefixes in `helpers.js`
`MODEL_CONFIGS`. The Sortformer Streaming v2.1 q8_0 model is included so
`sortformer-aosc-streaming.test.js` resolves it locally instead of downloading
it during the test timeout. Mobile q4_0/f16 streaming models are provisioned
separately by the Device Farm workflow.
