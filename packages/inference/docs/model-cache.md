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

Apple Parakeet loads with available Core ML encoder bundles use the existing
`sets/<setKey>/` cache layout. The GGUF and each `.mlmodelc` directory live in
that set, so `clearStorage` removes them together. When a sidecar is absent or
unavailable, the GGUF uses its ordinary single-file cache path.

The current schemas and handlers are authoritative for supported fields and model
types. Do not maintain a second field inventory here.
