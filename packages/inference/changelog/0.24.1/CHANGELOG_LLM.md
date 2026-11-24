# QVAC Inference v0.24.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.24.1

QVAC Inference 0.24.1 keeps existing chats on their KV cache when prompt-cache sharing is turned on, and moves the engine to `bare-https` 4. `@qvac/sdk@0.24.0` picks it up on a fresh install through its `^0.24.0` range.

## Bug Fixes

### Chats keep their KV cache when `cache_share_across_keys` is turned on

Turning on `cache_share_across_keys`, which `seedFrom` requires, used to move every chat to a new cache folder. The next turn of each existing chat missed its cache and reprocessed its whole history. The cache folder name no longer depends on that setting, so existing cache files are found with no migration.

The folder name also leaves out `openclCacheDir`, `verbosity` and `cache_ram_mib`, which do not change what a cache file holds. On Android `openclCacheDir` carries the SDK version, so before this every SDK upgrade replayed every chat once.

`deleteCache({ kvCacheKey, modelId })` still removes the right folder, including from a process that never loaded the model. The engine records the folder for a model under `~/.qvac/kv-cache-dir-ids/`.

## Dependencies

### `bare-https` 4

The engine now depends on `bare-https@^4.0.0` and on `@qvac/tts-ggml@^0.15.2`, which made the same move, so an install still carries a single `bare-tls` version.
