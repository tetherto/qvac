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

## Stop the managed serve with the project, and move to CLI 0.19

PR: [#5700](https://github.com/tetherto/qvac/pull/5700)

- The plugin no longer installs `SIGINT`, `SIGTERM` and exit handlers. OpenCode stops the managed `qvac serve` when it unloads the project: after 60 minutes without session activity, or when the OpenCode service stops.
- Dependencies are now `@qvac/cli@^0.19.0` and `@qvac/ai-sdk-provider@^0.12.0`, so the managed serve runs CLI 0.19.

---
