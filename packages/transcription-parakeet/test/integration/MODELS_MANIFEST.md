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

The `bytes` and `sha256` fields are currently unpinned. Until they are populated,
staging validates only that each file is present and non-empty. To pin them,
stage the complete model set and run:

```sh
npm run generate-model-manifest
```

Commit the generated sizes and hashes. After pinning, staging verifies cached
and freshly downloaded files and rejects mismatches. Running `--check` alone
does not create missing pins.

The S3 date prefixes mirror the registry prefixes in `helpers.js`
`MODEL_CONFIGS`. The Sortformer Streaming v2.1 q8_0 model is included so
`sortformer-aosc-streaming.test.js` resolves it locally instead of downloading
it during the test timeout. Mobile q4_0/f16 streaming models are provisioned
separately by the Device Farm workflow.
