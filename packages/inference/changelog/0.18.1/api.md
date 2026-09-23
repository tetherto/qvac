# 🔌 API Changes v0.18.1

## Describe llamacpp modelConfig fields

PR: [#3975](https://github.com/tetherto/qvac/pull/3975)

llamacpp completion and embedding config schema fields now carry `.describe()` text. Example: `ctx_size` is "Context window size in tokens; `0` uses the model's trained context length. Default 1024."

The internal schema identifiers are unchanged.

---
