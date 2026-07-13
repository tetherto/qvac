# Integration model manifest

`models.manifest.json` is the single source of truth for Diffusion integration
model URLs and integrity pins. Every model must use an immutable source revision
and pin both `sha256` and `bytes`.

The CI model-cache key hashes the manifest. Keep rationale and operational
documentation in this file so prose-only edits do not invalidate the multi-GB
cache.

Package-prefix cache restores remain enabled so unchanged models can be reused
after a manifest update. The warm step and runtime verify every restored file
and replace it when either pin does not match. Cache hits are never treated as
integrity provenance; every restored file is checked.

Every model declares a non-overlapping cache `group`: `base`, `ideogram`, or
`ltx`. CI restores and warms `base` on every self-hosted integration runner,
adds `ideogram` only where the Ideogram test runs, and adds `ltx` only on the
LTX runner. Each cache archives exact manifest-declared file paths, so generated
outputs and platform-specific files are excluded.

To refresh pins from fresh downloads, run:

```sh
node scripts/generate-model-manifest.mjs --force
```

Do not derive pins from the restored model cache. For Hugging Face LFS objects,
the generator also requires the downloaded digest and size to match the source
`X-Linked-ETag` and `X-Linked-Size` metadata.

The FLUX.2 VAE uses the Black Forest Labs source. The previously listed Comfy
file is a different artifact: its SHA-256 and byte size do not match the model
expected by the integration tests, so it must not be used as a mirror.
