# QVAC SDK v0.24.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.24.1

QVAC SDK 0.24.1 moves the SDK onto `@qvac/inference` 0.24.1. Existing chats keep their KV cache when prompt-cache sharing is turned on, and the engine is on `bare-https` 4. The Python and Kotlin clients are released at the same version.

## Bug Fixes

### Chats keep their KV cache when `cache_share_across_keys` is turned on

Turning on `cache_share_across_keys`, which `seedFrom` requires, used to move every chat to a new cache folder. The next turn of each existing chat missed its cache and reprocessed its whole history. The cache folder name no longer depends on that setting, so existing cache files are found with no migration.

The folder name also leaves out `openclCacheDir`, `verbosity` and `cache_ram_mib`, which do not change what a cache file holds. On Android `openclCacheDir` carries the SDK version, so before this every SDK upgrade replayed every chat once.

`deleteCache({ kvCacheKey, modelId })` still removes the right folder, including from a process that never loaded the model.

## Dependencies

### `@qvac/inference` 0.24.1 and `bare-https` 4

The SDK now depends on `@qvac/inference@^0.24.1` and `@qvac/tts-ggml@^0.15.2`. Both are on `bare-https` 4, so an install still carries a single `bare-tls` version.
