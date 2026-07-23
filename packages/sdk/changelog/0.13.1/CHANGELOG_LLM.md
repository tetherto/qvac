# Changelog v0.13.1 (LLM)

Dependency-maintenance patch. No public API changes.

- `bare-fetch` → `^3.0.1` (transitive-only major; fetch API unchanged; only 3.0.1 header validation, all SDK headers are RFC-valid).
- dev `bare-subprocess` → `^6.1.0` (not shipped to consumers).
- `@qvac/decoder-audio` → `^0.4.0`: removes the deprecated `@qvac/response` package (folded into `@qvac/infer-base`) from the dependency tree, eliminating its exact `bare-events 2.4.2` pin. `decoder-audio@0.4.0`'s `run()` returns `QvacResponse` synchronously; `server/utils/audio/decoder.ts` updated to not `await` it.
- `@qvac/sdk` + `@qvac/bare-sdk` bumped in lockstep.
- Validated by a clean install: no `@qvac/response`, no `bare-events@2.4.2`, no `bare-fetch@2.x`, no `decoder-audio@0.3.x` resolve in the tree.
