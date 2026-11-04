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

## Serve system resources and model fit on /qvac/v1

PR: [#5219](https://github.com/tetherto/qvac/pull/5219)

```bash
curl "http://localhost:11434/qvac/v1/system?sample=true"

curl http://localhost:11434/qvac/v1/models/fit \
  -H "Content-Type: application/json" \
  -d '{"models":[{"model":"my-llm","modelConfig":{"ctx_size":8192}}]}'
```

---

## Stream /v1/audio/speech over SSE

PR: [#5220](https://github.com/tetherto/qvac/pull/5220)

```bash
curl -N http://localhost:11434/v1/audio/speech -H "Content-Type: application/json" \
  -d '{"model":"my-tts","input":"Hello.","response_format":"pcm","stream_format":"sse"}'
# data: {"type":"speech.audio.delta","audio":"<base64>"}
# data: {"type":"speech.audio.done","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}
```

---

## Serve batch chat completion on /qvac/v1/chat/batch

PR: [#5247](https://github.com/tetherto/qvac/pull/5247)

```bash
curl http://localhost:11434/qvac/v1/chat/batch \
  -H "Content-Type: application/json" \
  -d '{"model":"my-llm","prompts":[
        {"id":"a","messages":[{"role":"user","content":"Reply with only the word CHERRY."}]},
        {"id":"b","messages":[{"role":"user","content":"Reply with only the word BANANA."}]}]}'
```

---
