# @qvac/registry-client v0.7.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/registry-client/v/0.7.0

This release exposes fit blobs to consumers. A model record can now carry a pointer to a weightless copy of its artifact — every tensor described, no weights — which an engine's dry-run fitter reads to decide whether a model fits in the memory available, without downloading gigabytes. Reading the pointer requires `@qvac/registry-schema@^0.4.0` (spec version 3), which this release pulls in.

---

## ✨ Features

### `fitBlobBinding` on a model entry (#4445)

`QVACModelEntry.fitBlobBinding` is an optional `QVACBlobBinding`, the same shape as `blobBinding`, and `downloadBlob` takes it directly:

```js
const model = await client.getModel(path, source)

if (model.fitBlobBinding) {
  await client.downloadBlob(model.fitBlobBinding, { outputFile: './fit.gguf' })
}
```

The field is absent on records ingested before it existed, so a consumer checks for it and falls back to the full artifact.

It addresses the writer's active blob core, which is not always the core holding the weights — the binding carries its own `coreKey`, and `downloadBlob` uses that rather than the model's.

## 🔧 Changed

### `QVACBlobBinding` declares `sha256`

The schema has always carried the checksum and the typing omitted it. Code that reads a binding is unaffected. Code that constructs one has to supply `sha256`, matching how every other checksum in the SDK ecosystem is typed.

### Schema dependency

`@qvac/registry-schema` moves from `^0.3.0` to `^0.4.0`. Spec version 3 appends `fitBlobBinding` as an optional field, so a reader on version 2 skips it and older records decode unchanged.
