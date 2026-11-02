# Model cache

The public cache and lifecycle operations are implemented by the API, handler,
schema, and runtime modules under `src/`. `@qvac/sdk` exposes corresponding client
operations over its worker transport.

- Treat model descriptors and normalized source identifiers as identities, not only
  raw URLs.
- Preserve download deduplication and subscriber-aware cancellation when changing
  asset retrieval.
- Keep cache paths within the configured cache root and validate destructive cache
  targets before deleting them.
- Model loading and unloading are explicit lifecycle operations. Do not add implicit
  eviction or teardown without a public contract decision.
- Update schemas, both in-process and SDK transport callers, and focused tests when
  changing a cache-management response.

A GGUF downloaded with its Core ML bundle on macOS or iOS uses the
`sets/<setKey>/` companion-set layout: the GGUF and the `.mlmodelc` directory sit
side by side, with a metadata file that lets a later load reopen the set without
registry access. When that GGUF is the loaded model's primary file,
`clearStorage` removes the whole set, bundle included. A GGUF loaded without a
bundle uses its ordinary single-file cache path.

The current schemas and handlers are authoritative for supported fields and model
types. Do not maintain a second field inventory here.

## Integrity verification reuse

Registry and Hyperdrive artifact checks reuse SHA-256 digests within the engine
process, including companion files and shards. Reuse requires an unchanged
absolute path, device, inode, size, modification time, and change time. Missing,
modified, truncated, or replaced files invalidate reuse; every check still compares
against the requested checksum. When usable identity metadata is available,
verification rejects files whose metadata changes during hashing. Filesystems
without usable identity metadata are always hashed.
The digest cache is bounded and is not persisted: the first verification after a
process restart reads the file again. HTTP cache freshness behavior is unchanged.
This detects filesystem-visible changes; detecting silent corruption that leaves
all file metadata unchanged requires a fresh hash (for example after restart).
