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

The sole exception is
`stable-diffusion-v2-1-Q4_0.gguf`. Hugging Face reports source SHA
`3bc6163b7e7979aab49cc9dd76a98b99945f6a3cca8ba14411d730380c1a10e1` in
`X-Linked-ETag`, while fresh downloads across Linux, macOS, and Windows hash to
`27740067fae2c988f64839ae806d989eb6d5aa6cfe5d47c8994c100677ef97e4`;
the QVAC central registry independently pins the same served-byte SHA and
immutable `12ddc22724f6da35f0b6006e459fae66eaf56931` revision. Its manifest
entry records the upstream headers as `sourceSha256`/`sourceBytes` and the bytes
consumed at runtime as `sha256`/`bytes`.

This exception remains fail-closed: it is accepted only for an immutable,
exact-host HTTPS Hugging Face URL when both source headers match the committed
source pins and the fresh download matches the already committed runtime pins.
Missing fields, changed headers, changed bytes, mutable URLs, and unrecognized
mismatches fail. Do not add source fields merely to make generation pass.

The manifest content hash changes the cache key when any of these values change,
so this correction does not require a `cacheEpoch` bump.

The FLUX.2 VAE uses the Black Forest Labs source. The previously listed Comfy
file is a different artifact: its SHA-256 and byte size do not match the model
expected by the integration tests, so it must not be used as a mirror.
