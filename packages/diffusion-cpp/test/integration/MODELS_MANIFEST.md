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
the generator requires the downloaded digest and size to match the source
`X-Linked-ETag` and `X-Linked-Size` metadata. There is no source-mismatch
exception: every artifact must satisfy `downloaded SHA/size == canonical content
address`.

A source whose delivered bytes disagree with its own immutable content address
is unauditable and must be replaced, not documented. The gpustack
`stable-diffusion-v2-1-Q4_0.gguf` file was the real-world case: it is served over
legacy Hugging Face LFS with a stored blob that hashes to
`27740067…` while its pointer OID (`X-Linked-ETag`) is `3bc6163b…`, so the
canonical object is unrecoverable. It was removed from the manifest; the generic
behavior, ESRGAN, and GPU-backend tests use the Xet-backed, content-address-
matching `stable-diffusion-v2-1-Q8_0.gguf` instead, and Q4-format coverage
remains via `stable-diffusion-xl-base-1.0-Q4_0.gguf`.

The manifest content hash changes the cache key when any of these values change.

The FLUX.2 VAE uses the Black Forest Labs source. The previously listed Comfy
file is a different artifact: its SHA-256 and byte size do not match the model
expected by the integration tests, so it must not be used as a mirror.
