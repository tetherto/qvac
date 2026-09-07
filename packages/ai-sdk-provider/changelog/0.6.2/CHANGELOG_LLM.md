# QVAC AI SDK Provider v0.6.2 Release Notes

Release Date: 2026-09-04

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.6.2

## Streamed File Uploads Work Again

`@ai-sdk/provider` 4.0.10 added a third `uploadFile` data variant, `{ type: 'stream', stream }`, and the AI SDK hands it straight to the provider whenever a caller uploads from a stream. Version 0.6.1 did not recognise it and threw a `TypeError` instead of uploading. `uploadFile` now drains the stream and posts the bytes.

The stream is drained rather than forwarded as a streaming request body on purpose: `POST /v1/files` buffers the whole upload into serve's in-memory ephemeral store, so a streaming request would only require `duplex: 'half'` support from the caller's `fetch` without anything streaming on the other end.

An unrecognised data variant now rejects with `UnsupportedFunctionalityError`, naming the variant, so a future addition upstream fails the one unsupported call with a clear error.

## Upload Calls Honour `abortSignal` and `headers`

Both options are part of the files interface and the AI SDK already passed them, but the QVAC adapter dropped them:

- `abortSignal` is now forwarded, so an in-flight upload can be cancelled.
- Per-call `headers` are now merged over the configured provider headers, matching the behaviour of every other adapter in this package. The configured `Content-Type` is still stripped so `fetch` picks the multipart boundary itself.

Callers already passing `abortSignal` will see uploads actually abort where they previously ran to completion.

No provider API surface changed in this patch release.
