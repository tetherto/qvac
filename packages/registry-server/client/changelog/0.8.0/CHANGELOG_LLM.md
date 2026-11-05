# @qvac/registry-client v0.8.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/registry-client/v/0.8.0

This release lets a paused registry download resume. Since 0.6.x a cancelled download cleared its cached blocks, so pausing and resuming started again from 0%. A caller can now keep those blocks, and reclaim them later with `clearBlob` if the download is abandoned.

---

## ✨ Features

### `clearBlocksOnCancel` on downloads (#5534)

`downloadModel` and `downloadBlob` take `clearBlocksOnCancel` alongside `outputFile` and `signal`. It is a boolean, or a callback the client reads at the moment the signal aborts, so the caller can decide between pause and cancel after the download has started:

```js
let pausing = false
const controller = new AbortController()

const download = client.downloadModel(path, source, {
  outputFile,
  signal: controller.signal,
  clearBlocksOnCancel: () => !pausing
})

// Pause: keep the blocks, the next downloadModel of this model resumes from them.
pausing = true
controller.abort()
```

The default is `true`, so a caller that passes nothing keeps 0.7.0's behaviour. A callback that throws falls back to clearing.

### `clearBlob(binding)` (#5534)

Deletes a blob's cached blocks from the corestore. It takes `{ coreKey, blockOffset, blockLength }`, works offline, and reports a failed clear:

```js
await client.clearBlob(model.blobBinding)
```

## 🔧 Changed

### Failed downloads keep their blocks

A download that fails without being cancelled, for example after its retries run out, now keeps its blocks so the next attempt resumes. Use `clearBlob` to reclaim a download that will not be retried.

## 🐛 Fixed

- A download of a blob waits for any earlier cancel or `clearBlob` of the same blob to finish. Before, a quick resume could count blocks the previous cancel was about to delete, then stall at 100%.
