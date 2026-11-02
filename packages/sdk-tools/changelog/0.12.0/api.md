# 🔌 API Changes v0.12.0

## Honor preload:false via lazy-load, keep DELETE reversible

PR: [#3906](https://github.com/tetherto/qvac/pull/3906)

```bash
# preload:false model — first request lazy-loads it (blocks), later requests are fast
curl -X POST http://localhost:11434/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"my-llm","messages":[{"role":"user","content":"hi"}]}'

# unload frees resources but keeps the alias; the next request reloads it
curl -X DELETE http://localhost:11434/v1/models/my-llm

# lists every configured model, loaded or not
curl http://localhost:11434/v1/models
```

New `qvac serve openai` flags controlling the lazy load:

```bash
qvac serve openai --no-lazy-load                   # 503 model_not_loaded instead of loading
qvac serve openai --load-concurrency 2             # max simultaneous loads (default: 1)
qvac serve openai --load-timeout 300000            # per-load timeout in ms (default: unbounded)
qvac serve openai --no-cancel-load-on-disconnect   # keep loading if the client disconnects
```

Equivalent config, which the flags override:

```json
{
  "serve": {
    "load": { "lazy": true, "concurrency": 1, "timeoutMs": null, "cancelOnDisconnect": true }
  }
}
```

---

## Browse models by capability (serve catalog)

PR: [#3932](https://github.com/tetherto/qvac/pull/3932)

```bash
# Browse chat-capable models the SDK provides (not configured → not callable yet)
curl 'http://localhost:11434/v1/models/catalog?role=chat&limit=20'
# → { "object":"list", "data":[ { "object":"model_catalog_entry", "id":"QWEN3_600M_INST_Q4",
#      "configured":false, "usable":false, "state":"not_configured", "role":"chat",
#      "addon":"llm", "quantization":"q4", "params":"600M", "size":382156480, "hint":"…" } ],
#     "has_more": true }

curl 'http://localhost:11434/v1/models/catalog?search=qwen'
curl 'http://localhost:11434/v1/models/catalog/QWEN3_600M_INST_Q4'
```

---
