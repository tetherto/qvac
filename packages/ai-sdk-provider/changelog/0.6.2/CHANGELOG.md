# Changelog v0.6.2

Release Date: 2026-09-04

## 🐞 Fixes

- Accept the streamed file-upload input. `uploadFile` now handles the `{ type: 'stream' }` data variant that `@ai-sdk/provider` 4.0.10 added and the AI SDK passes straight through, instead of throwing a `TypeError` on it.
- Forward the per-call `abortSignal` to the upload request, so an in-flight upload can be cancelled.
- Forward per-call `headers` to the upload request, matching every other adapter in the provider.
- Reject an unrecognised upload data variant with `UnsupportedFunctionalityError` rather than failing at an arbitrary point in the request.
