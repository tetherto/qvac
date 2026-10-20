# 💥 Breaking Changes v0.23.0

## Vector indexing moves to `@qvac/turbovec-ggml`

PR: [#5227](https://github.com/tetherto/qvac/pull/5227)

`@qvac/embed-llamacpp` 0.50 no longer exports `IdMapIndex`. The embedding plugin imports it from `@qvac/turbovec-ggml`, a new optional peer. The `@qvac/embed-llamacpp` peer moves to `^0.50.0`. Hosts that install the peers themselves must add `@qvac/turbovec-ggml` and upgrade `@qvac/embed-llamacpp` to use the embedding plugin. `@qvac/sdk` 0.23 depends on both, so SDK users have nothing to change.

**BEFORE:**

```json
{
  "dependencies": {
    "@qvac/inference": "^0.22.0",
    "@qvac/embed-llamacpp": "^0.48.1"
  }
}
```

**AFTER:**

```json
{
  "dependencies": {
    "@qvac/inference": "^0.23.0",
    "@qvac/embed-llamacpp": "^0.50.0",
    "@qvac/turbovec-ggml": "^0.1.1"
  }
}
```

---
