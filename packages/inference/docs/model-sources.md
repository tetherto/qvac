# Model sources and generated constants

Model source schemas live under `src/schemas/`; generated registry constants live
under `src/models/registry/`. The SDK re-exports the inference model registry.

- Accept only source shapes represented by the public schema.
- Preserve descriptor metadata needed for multi-file and sharded models while
  maintaining compatibility with supported string sources.
- Regenerate model constants through the package script; never edit generated files
  by hand.
- Update source normalization, load/download schemas, handlers, generated outputs,
  and focused tests together when the source contract changes.
- Use the live registry input and generator as the authority for names and metadata;
  do not maintain a hand-written model inventory in documentation.

A model descriptor's `engine` identifies its canonical plugin, independently of
which addon package implements it. Multiple plugins can share an addon without
making their model descriptors interchangeable. Explicit `modelType` selection
must match the descriptor's engine. Legacy package-valued engines remain supported
for compatibility, but package identity cannot distinguish capabilities that share
an addon.

Registry submissions, live queries, and the generated catalog must agree on the
canonical engine. Use `resolveRegistryEngine` for registry metadata; it preserves
recognized legacy package IDs and their discriminator tags. Canonical engine
identity takes precedence over tags. A shared package ID without an unambiguous
legacy rule stays unresolved. Submission validation reads the supported engines
and these rules from a manifest inside the registry package, generated from the
same canonical definitions as the SDK contract.
Sync corrected registry metadata before clients rely on registry-returned
descriptors, and coordinate rollout with clients that recognize the engine.
Regenerate the catalog and downstream clients from the corrected metadata; do not
patch generated constants or bypass model-type validation.

On macOS and iOS, a registry GGUF can pair with a compiled Apple Core ML bundle
that the native addon runs a stage on when it sits next to the GGUF; the pairs
are listed in `src/handlers/load-model/coreml-sidecars.ts`. The registry
publishes each `.mlmodelc` component as its own file, and the catalog keeps them
as companion-only entries, never as model constants. The resolver discovers a
complete bundle and downloads it with the GGUF, preserving the directory layout
the addon expects. Without a complete bundle, and on every other platform, the
GGUF loads on its own.
