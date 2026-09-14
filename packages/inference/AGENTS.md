# Inference engine guidance

Read this package's README, manifest, source, and focused tests before changing an
engine contract. `@qvac/inference` owns the in-process Bare runtime; `@qvac/sdk`
adapts it to client/worker environments.

- Keep the engine Bare-compatible and avoid Node-only dependencies.
- Preserve the plugin contract and keep built-in and external plugins on the same
  public extension surface.
- Use request contexts and disposable scopes for cancellation and cleanup; do not
  introduce independent cancellation flags or ad-hoc resource ownership.
- Keep model sources, generated constants, configuration, cache paths, and runtime
  state in their existing owning modules rather than duplicating them in the SDK.
- Use structured errors, preserve causes, and keep cancellation outcomes consistent
  between event streams and aggregate promises.
- Update the relevant file under `docs/` in place when these contracts change:
  configuration, model/cache ownership, model sources, KV cache, or request
  lifecycle.
- Inspect `package.json` and run the narrowest relevant format, lint, type, unit,
  integration, and generation checks before handoff.
