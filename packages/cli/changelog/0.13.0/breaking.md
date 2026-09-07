# 💥 Breaking Changes v0.13.0

## Mount the serve surfaces as extensions

PR: [#4164](https://github.com/tetherto/qvac/pull/4164)

**BEFORE:**

```bash
qvac serve            # prints help
qvac serve openai     # serves /v1/*
```

**AFTER:**

```bash
qvac serve                          # serves the QVAC surface only
qvac serve --openai                 # QVAC + /v1/*
qvac serve --openai --no-default    # /v1/* only
qvac serve openai                   # same as above, warns that it is deprecated
```

`qvac serve openai` keeps every flag it had and the same behaviour. It prints a deprecation warning on start.

`qvac openai spec` emits the same paths, schemas and tags as before. Two `info` lines change, because the document now names the mounted surfaces:

```
BEFORE: "title": "QVAC OpenAI-compatible API"
        "description": "OpenAI-compatible REST API served by `qvac serve openai`."
AFTER:  "title": "QVAC API"
        "description": "Mounted surfaces: openai (OpenAI-compatible REST API)."
```

Config is unchanged: `serve.models` and all existing keys keep their meaning. OpenAI-specific keys move under `serve.openai`, and an unknown `serve.*` key now logs a warning instead of being silently dropped.

---
