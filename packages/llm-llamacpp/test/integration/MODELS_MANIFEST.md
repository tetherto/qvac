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

Entries used only by opt-in benchmarks may set `"warm": false`. They remain
fully pinned and can still be downloaded lazily or selected for mobile
pre-staging, but the ordinary desktop cache warmer will not fetch them on every
self-hosted runner. Omit `warm` for models used by normal integration tests.

A model that is no longer on Hugging Face can be pinned to the QVAC model
registry bucket instead: give it an `s3Path` (the registry path under
`qvac_models_compiled/`) in place of `urls`, with the registry's `sha256` and
`bytes`. CI stages these with `scripts/stage-s3-models.mjs` (needs
`MODEL_S3_BUCKET` and AWS credentials); the cache warmer skips them, and mobile
runs get them from the presigned US-bucket mirror. The mobile pre-stage map
lists them by name only, with no `url`.

To populate pins from fresh downloads, run:

```sh
node scripts/generate-model-manifest.mjs
```

Do not derive pins from the restored model cache.
