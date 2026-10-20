# 💥 Breaking Changes v0.4.0

## Start the OpenClaw serve in the plugin and verify its port

PR: [#5025](https://github.com/tetherto/qvac/pull/5025)

**BEFORE:**
`models.providers.qvac` in `openclaw.json`

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "localService": { "healthUrl": "http://127.0.0.1:11434/v1/models" }
}
```

**AFTER:**
re-run `openclaw onboard --auth-choice provider-plugin:qvac`

```json
{ "baseUrl": "http://qvac.invalid/v1" }
```

---

## Requires the @qvac/cli 0.16 line

`@qvac/cli` 0.16 is required for `--port 0 --ready-fd 3`. The dependency floors move with it.

**BEFORE:**

```json
{ "dependencies": { "@qvac/ai-sdk-provider": "^0.9.0", "@qvac/cli": "^0.15.0" } }
```

**AFTER:**

```json
{ "dependencies": { "@qvac/ai-sdk-provider": "^0.10.0", "@qvac/cli": "^0.16.0" } }
```

- Installs that pin `@qvac/cli` to `0.15.x` must move to `0.16.x` alongside the plugin, since a 0.x caret range does not cross a minor.
- `@qvac/ai-sdk-provider` moves to `^0.10.0` in the same step. Provider 0.10 narrows its own optional `@qvac/cli` peer to `^0.16.0`.

---
