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
