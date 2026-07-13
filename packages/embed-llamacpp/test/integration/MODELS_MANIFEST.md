# Integration model manifest

`models.manifest.json` is the single source of truth for integration-model URLs
and optional `sha256`/`bytes` integrity pins. The Android pre-stage generator
also reads this manifest, so desktop downloads, cache warming, and mobile
pre-staging cannot drift between separate URL lists.

The CI model-cache key hashes the manifest. Keep rationale and operational
documentation in this file so prose-only edits do not invalidate the model
cache.

Not every model is integrity-pinned yet. Until all entries have immutable URLs
and pins, the embed integration workflow disables package-prefix cache restores.
Therefore, changing the manifest or incrementing `cacheEpoch` causes an exact
cache-key miss instead of restoring stale same-named files from an older cache.

To populate pins from fresh downloads, run:

```sh
node scripts/generate-model-manifest.mjs
```

Do not derive pins from the restored model cache.
