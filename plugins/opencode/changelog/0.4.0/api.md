# 🔌 API Changes v0.4.0

## Capture qvac serve output in the OpenCode compat smoke

PR: [#5445](https://github.com/tetherto/qvac/pull/5445)

```json
{
  "plugins": [
    {
      "package": "@qvac/opencode-plugin",
      "options": { "serveBinPath": "/abs/path/qvac-serve-wrapper.sh" }
    }
  ]
}
```

```bash
QVAC_SERVE_BIN_PATH=/abs/path/qvac-serve-wrapper.sh opencode
```

---
