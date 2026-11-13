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

`serveBinPath` must be an absolute path; a relative one throws `InvalidOptionError`, and an empty value keeps the bundled CLI. With it set, the serve key is passed on the command line as `--api-key`, where other local users can read it, so use it only on single-user machines such as CI runners.

---
