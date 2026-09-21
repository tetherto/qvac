# Changelog v0.7.0

Release Date: 2026-09-04

## 💥 Breaking Changes

- Managed mode requires `@qvac/cli` 0.13. The optional CLI peer narrows to `^0.13.0`, dropping the `0.10`–`0.12` lines, which have no `--openai` flag.

## 🐞 Fixes

- Launch the managed serve as `qvac serve --openai --no-default` instead of the `qvac serve openai` subcommand that CLI 0.13 deprecated. The flag pair is what the subcommand expanded to, so the serve still exposes only `/v1/*`.
- Accept the streamed file-upload input. `uploadFile` handles the `{ type: 'stream' }` data variant that `@ai-sdk/provider` 4.0.10 added and the AI SDK passes straight through, instead of throwing a `TypeError` on it.
- Forward the per-call `abortSignal` to the upload request, so an in-flight upload can be cancelled.
- Forward per-call `headers` to the upload request, matching every other adapter in the provider.
- Reject an unrecognised upload data variant with `UnsupportedFunctionalityError` rather than failing at an arbitrary point in the request.
