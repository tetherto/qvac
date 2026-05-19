# QVAC SDK v0.8.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.3

This is a patch release that fixes a race condition in the KV cache save path during tool-calling completions, improving stability for multi-turn conversations that use tool integration.

---

## 🐞 Bug Fixes

### KV Cache Save Race Condition in Tool-Calling Completions

The KV cache save during tool-calling completions could race with ongoing inference because the session path was not passed to the save command and the save response was not awaited. This could result in corrupted or missing session state between tool-call rounds.

The fix ensures the save command receives the correct session path and the SDK awaits the save response before proceeding. If the save fails, the error is now logged as a warning instead of propagating as an unhandled exception, so inference can continue gracefully.

**What changed:**

- The cache save now explicitly passes the session path alongside the save instruction, preventing the addon from writing to a stale or missing path
- The save response is awaited so subsequent inference steps don't race against an in-flight disk write
- A new `logCacheSaveError` helper captures save failures as warnings, keeping the completion stream alive even if the cache write fails

---

## 📘 Documentation

- Added npm keywords to `package.json` for better discoverability on the npm registry, covering AI/ML, inference engines, supported platforms, and P2P capabilities.
- Added a link to the consolidated plaintext documentation export (`llms-full.txt`) in the SDK README for AI/LLM tool consumption.
