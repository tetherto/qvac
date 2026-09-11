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
