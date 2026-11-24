# QVAC Inference v0.24.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.24.1

QVAC Inference 0.24.1 keeps existing chats on their KV cache when prompt-cache sharing is turned on, including for loads that send `verbosity`, and moves the engine to `bare-https` 4. `@qvac/sdk@0.24.0` picks it up on a fresh install through its `^0.24.0` range.

## Bug Fixes

### Chats keep their KV cache when `cache_share_across_keys` is turned on

Turning on `cache_share_across_keys`, which `seedFrom` requires, used to move every chat to a new cache folder. The next turn of each existing chat missed its cache and reprocessed its whole history. The cache folder name no longer depends on that setting, so existing cache files are found with no migration.

The folder name also ignores other settings that do not change what a cache file holds. A `verbosity` sent at load counts as its default `0`, and `openclCacheDir` and `cache_ram_mib` are left out, so changing any of them later keeps the folder. A caller that puts a versioned path in `openclCacheDir` no longer replays every chat on each upgrade. A load that omits `verbosity` and one that sends it still get different folders, as in 0.24.0.

`deleteCache({ kvCacheKey, modelId })` still removes the right folder, including from a process that never loaded the model. The engine records the folder for a model under `~/.qvac/kv-cache-dir-ids/`.

### Which loads keep their folder from 0.24.0

A load with sharing off, `verbosity` omitted or `0`, and neither `openclCacheDir` nor `cache_ram_mib` keeps the folder it had on 0.24.0. That covers the SDK defaults and callers that send `verbosity: 0` on every load.

A load that already had `cache_share_across_keys` on, sent a non-zero `verbosity`, or sent `openclCacheDir` or `cache_ram_mib` moves to a new folder once. The next turn of each of its chats reprocesses the history once, and the old folder stays on disk. `deleteCache` with that model id no longer reaches it; `deleteCache` with only the `kvCacheKey` still removes it.

## Dependencies

### `bare-https` 4

The engine now depends on `bare-https@^4.0.0` and on `@qvac/tts-ggml@^0.15.2`, which made the same move, so an install still carries a single `bare-tls` version.
