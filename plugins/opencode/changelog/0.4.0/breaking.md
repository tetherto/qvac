# 💥 Breaking Changes v0.4.0

## Port @qvac/opencode-plugin to the OpenCode 2.x plugin API

PR: [#5700](https://github.com/tetherto/qvac/pull/5700)

**BEFORE:**

```json
{ "plugin": [["@qvac/opencode-plugin", { "model": "qwen3.5-2b" }]] }
```

**AFTER:**

```json
{ "plugins": [{ "package": "@qvac/opencode-plugin", "options": { "model": "qwen3.5-2b" } }] }
```

- Requires OpenCode 2.x. On OpenCode 1.x, stay on `@qvac/opencode-plugin@0.3`.
- Configure under `plugins`. Options move from a `[name, options]` tuple to `{ "package", "options" }`.
- `setDefaultModel` now sets only the default model; OpenCode 2.x has no small-model setting for plugins.

---
