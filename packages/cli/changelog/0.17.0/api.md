# 🔌 API Changes v0.17.0

## Add the OpenAI Decisions endpoint to qvac serve --openai

PR: [#5176](https://github.com/tetherto/qvac/pull/5176)

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

---

## Allow extra Host headers on qvac serve

PR: [#5141](https://github.com/tetherto/qvac/pull/5141)

```bash
qvac serve --openai --allowed-host qvac.internal --allowed-host .corp.example
qvac serve --openai --allow-any-host
```

```json
{ "serve": { "allowedHosts": ["qvac.internal"] } }
```

---

## CPU polling controls on llama.cpp aliases

PR: [#5216](https://github.com/tetherto/qvac/pull/5216)

`@qvac/sdk` 0.23 accepts `poll` and `pollBatch` (integers from 0 to 100) on completion, embedding and decision configs. Serve aliases pass them through `serve.models[].config`.

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

---
