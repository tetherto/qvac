# Integration model manifest

`models.manifest.json` is the single source of truth for integration-model URLs
and optional `sha256`/`bytes` integrity pins. Its model keys are the local
filenames used by tests, which may differ from the remote filename.

The CI model-cache key hashes the manifest. Keep rationale and operational
documentation in this file so prose-only edits do not invalidate the multi-GB
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
