# 🔌 API Changes v0.3.0

## `response_format` support in OpenAI-compat `/v1/chat/completions`

PR: [#1810](https://github.com/tetherto/qvac/pull/1810)

```bash
curl http://localhost:8080/v1/chat/completions -d '{
  "model": "qwen-3-0.6b",
  "messages": [{ "role": "user", "content": "Give me a person object." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "Person",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age":  { "type": "integer" }
        },
        "required": ["name", "age"]
      }
    }
  }
}'
```

---

