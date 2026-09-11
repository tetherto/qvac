# Test-suite architecture

`@qvac/test-suite` coordinates consumer-defined tests across desktop and packaged
targets. The package is the harness, not the consumer test catalog.

## Boundaries

- `src/types/` and `src/schemas/` own configuration and wire contracts.
- `src/core/` owns producer/consumer orchestration and execution primitives.
- `src/cli/` owns build, launch, run, and reporting commands.
- `src/index.ts` is the Node/desktop public surface.
- `src/mobile-runtime.ts` is the reduced mobile-safe public surface.
- `templates/` contains source copied into generated consumer applications.

The source entry points and export tests are authoritative for the current API. Do
not duplicate export-name or schema-field inventories in this document.

## Invariants

- Keep producer and consumer messages schema-validated and correlated to one run.
- Keep mobile templates free of Node-only dependencies.
- Preserve configured package names when scaffolding generated consumers.
- Do not require checked-in `dist/`; clean builds must produce it.
- Keep reports deterministic and retain enough platform and run context to diagnose
  failures without exposing credentials.
- Update README usage and focused integration tests when changing CLI, configuration,
  transport, or generated-template behavior.
