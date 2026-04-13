# Changelog v0.8.3

Release Date: 2026-04-13

## 🐞 Bug Fixes

- Fix KV cache save race condition in tool-calling completions. The cache save now correctly passes the session path and awaits the save response, preventing a race where the session file could be written concurrently with ongoing tool-call inference. Errors during cache save are now logged as warnings instead of crashing. (see PR [#1298](https://github.com/tetherto/qvac/pull/1298))

## 📘 Docs

- Add npm keywords for better discoverability on the npm registry.
- Add llms.txt link to SDK README for AI/LLM tool consumption.
