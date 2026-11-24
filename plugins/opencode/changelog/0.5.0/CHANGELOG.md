# Changelog v0.5.0

Release Date: 2026-11-19

## ✨ Features

- Mark the served models as supporting `prompt_cache_key`, so OpenCode sends its session id and each session keeps its own KV cache across tool calls. (see PR [#5830](https://github.com/tetherto/qvac/pull/5830))

## Compatibility

- Released with the cli train. Depends on `@qvac/ai-sdk-provider@^0.12.1` and `@qvac/cli@^0.20.0`.
