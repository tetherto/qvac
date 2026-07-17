# Integration model manifest

`models.manifest.json` is the single source of truth for integration-model URLs
and optional `sha256`/`bytes` integrity pins. The Android pre-stage generator
also reads this manifest, so desktop downloads, cache warming, and mobile
pre-staging cannot drift between separate URL lists.

The CI model-cache key hashes the manifest. Keep rationale and operational
documentation in this file so prose-only edits do not invalidate the model
cache.

Every model must use an immutable source revision and pin both `sha256` and
`bytes`. Package-prefix cache restores remain enabled so unchanged models can be
reused after a manifest update. The warm step and runtime verify every restored
file and replace it when either pin does not match.

To populate pins from fresh downloads, run:

```sh
node scripts/generate-model-manifest.mjs
```

Do not derive pins from the restored model cache.
