# QVAC CLI v0.17.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.17.0

QVAC CLI 0.17.0 depends on `@qvac/sdk@0.23.0`. `qvac serve` now checks the `Host` header of every request, decision models move from `--systemone` to an OpenAI-style `POST /v1/decisions` endpoint under `--openai`, and llama.cpp aliases accept CPU polling controls.

Install `@qvac/cli@0.17.0` with `@qvac/sdk@^0.23.0`. The committed range is `^0.23.0`.

## Breaking Changes

### Host header check on `qvac serve`

A page that rebinds its own domain to `127.0.0.1` could read `/openapi.json` and call the server, because CORS does not apply to a same-origin request. Every request now needs a `Host` that names a loopback host, an IP address, the bind host, the `--public-base-url` host or an allowed host. Anything else gets `403 host_not_allowed`. The port is ignored.

Clients that dial `localhost`, `127.0.0.1`, `[::1]`, any IP address or the exact `--host` value are unaffected. A server reached by another hostname must allow that name.

**Before:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200
```

**After:**

```bash
qvac serve --openai --host 0.0.0.0 --api-key-file ./key --allowed-host gpu-box.lan
curl -H 'Authorization: Bearer …' http://gpu-box.lan:11434/v1/models   # 200; 403 host_not_allowed without --allowed-host
```

### `--systemone` is replaced by `POST /v1/decisions`

The `systemone` extension is removed. `--systemone`, `POST /v1/systemone` and the `serve.systemone` config block no longer exist. Decision aliases are served by `qvac serve --openai` at `POST /v1/decisions`. Questions are an ordered array instead of an object keyed by ID, and `noul` questions become `predicate` questions.

**Before:**

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

**After:**

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

## New APIs

### OpenAI Decisions endpoint

`POST /v1/decisions` answers predicate, choice and score questions with a configured local decision model. Input is text or a conversation. Answers keep the order of the questions, typed choice values and optional names. The response carries OpenAI-style token usage. The endpoint returns complete JSON; streaming, batch inputs, images and prompt caching are unsupported.

```bash
qvac configure --modality decision
qvac serve --openai
```

```bash
curl http://127.0.0.1:11434/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "laya-multilingual-322m-q8-0",
    "input": "Charged twice",
    "questions": [{
      "type": "predicate",
      "name": "urgent",
      "instructions": "Does this need immediate attention?"
    }]
  }'
```

### Allowed hosts

`--allowed-host <host>` is repeatable; a leading dot (`.corp.example`) covers subdomains. `serve.allowedHosts` sets the same list in config. `--allow-any-host`, or `"allowedHosts": true`, turns the check off.

```bash
qvac serve --openai --allowed-host qvac.internal --allowed-host .corp.example
qvac serve --openai --allow-any-host
```

```json
{ "serve": { "allowedHosts": ["qvac.internal"] } }
```

### CPU polling controls

Completion, embedding and decision aliases accept `poll` and `pollBatch`, integers from 0 to 100, in `serve.models[].config`. Unset values keep the native default, which now lets CPU workers sleep during GPU work. Higher values can reduce wake latency and use more CPU.

```json
{
  "serve": {
    "models": {
      "chat": {
        "model": "QWEN3_600M_INST_Q4",
        "config": { "poll": 50, "pollBatch": 0 }
      }
    }
  }
}
```
