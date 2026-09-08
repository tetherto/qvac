# QVAC AI SDK Provider v0.7.0 Release Notes

Release Date: 2026-09-04

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.7.0

Managed mode moves onto the CLI 0.13 launch interface. This release also carries the streamed file-upload fix from 0.6.2, so upgrading straight from 0.6.1 picks up both.

## Breaking Changes

### Managed mode requires `@qvac/cli` 0.13

`@qvac/cli` 0.13 mounts the serve surfaces as extensions and retires the `qvac serve openai` subcommand. Managed mode now launches `qvac serve --openai --no-default`, which the `0.10`–`0.12` lines cannot parse, so the optional CLI peer narrows to `^0.13.0`.

**Before:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.10.0 || ^0.11.0 || ^0.12.0" } }
```

**After:**

```json
{ "peerDependencies": { "@qvac/cli": "^0.13.0" } }
```

Install managed mode with:

```bash
npm install @qvac/ai-sdk-provider ai @ai-sdk/openai-compatible @qvac/cli@^0.13.0
```

External mode is unaffected — it never spawns a CLI, so it works against any serve that speaks the OpenAI-compatible surface.

`--no-default` is part of the launch command on purpose: bare `--openai` would also mount the QVAC surface on the port, while the retired subcommand exposed `/v1/*` alone. Keeping the pair preserves the previous behaviour and keeps the extra surface off a port the provider authenticates and owns.

## Fixes

### Streamed file uploads

`@ai-sdk/provider` 4.0.10 added a third `uploadFile` data variant, `{ type: 'stream', stream }`, and the AI SDK hands it straight to the provider whenever a caller uploads from a stream. Version 0.6.1 did not recognise it and threw a `TypeError`. `uploadFile` now drains the stream and posts the bytes.

The stream is drained rather than forwarded as a streaming request body on purpose: `POST /v1/files` buffers the whole upload into serve's in-memory ephemeral store, so a streaming request would only require `duplex: 'half'` support from the caller's `fetch` without anything streaming on the other end.

An unrecognised data variant now rejects with `UnsupportedFunctionalityError`, naming the variant, so a future addition upstream fails the one unsupported call with a clear error.

### Upload calls honour `abortSignal` and `headers`

Both options are part of the files interface and the AI SDK already passed them, but the QVAC adapter dropped them:

- `abortSignal` is now forwarded, so an in-flight upload can be cancelled.
- Per-call `headers` are now merged over the configured provider headers, matching the behaviour of every other adapter in this package. The configured `Content-Type` is still stripped so `fetch` picks the multipart boundary itself.

Callers already passing `abortSignal` will see uploads actually abort where they previously ran to completion.
