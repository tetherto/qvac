# 💥 Breaking Changes v0.4.0

## Requires OpenCode 2.x

_No migration code — OpenCode 2.x does not run V1 plugins, so the config entry changes with the OpenCode upgrade._

- The plugin now targets the OpenCode 2.x plugin API (`@opencode/plugin`). OpenCode 1.x cannot load it; stay on `@qvac/opencode-plugin@0.3` there.
- Configure it under `plugins`, not `plugin`. Options move from a `[name, options]` tuple to a `{ "package", "options" }` object.
- `setDefaultModel` now sets only the default model. OpenCode 2.x has no separate small-model setting for plugins to change.

**BEFORE (OpenCode 1.x, plugin 0.3.x):**

```json
{
  "plugin": [["@qvac/opencode-plugin", { "model": "qwen3.5-2b" }]]
}
```

**AFTER (OpenCode 2.x, plugin 0.4.0):**

```json
{
  "plugins": [{ "package": "@qvac/opencode-plugin", "options": { "model": "qwen3.5-2b" } }]
}
```

---
