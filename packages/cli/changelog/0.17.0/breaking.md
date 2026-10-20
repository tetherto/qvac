# 💥 Breaking Changes v0.17.0

## Reject unexpected Host headers on qvac serve

PR: [#5141](https://github.com/tetherto/qvac/pull/5141)

**BEFORE:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200
```

**AFTER:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key --allowed-host gpu-box.lan
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200; 403 host_not_allowed without --allowed-host
```

Clients that dial `localhost`, `127.0.0.1`, `[::1]`, any IP address or the exact `--host` value are unaffected.

---

## Replace `qvac serve --systemone` with `POST /v1/decisions`

PR: [#5176](https://github.com/tetherto/qvac/pull/5176)

The `systemone` extension is removed. `--systemone`, `POST /v1/systemone` and the `serve.systemone` config block no longer exist. Decision aliases are served by `qvac serve --openai` at `POST /v1/decisions`. Questions are an ordered array instead of an object keyed by ID, and `noul` questions become `predicate` questions.

**BEFORE:**

```bash
qvac serve --systemone
curl -sS http://127.0.0.1:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "laya",
    "state": "Please refund my duplicate payment.",
    "questions": {
      "refund": { "type": "noul", "instructions": "A refund is requested." }
    }
  }'
```

**AFTER:**

```bash
qvac serve --openai
curl -sS http://127.0.0.1:11434/v1/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "laya",
    "input": "Please refund my duplicate payment.",
    "questions": [
      { "type": "predicate", "name": "refund", "instructions": "A refund is requested." }
    ]
  }'
```

---
