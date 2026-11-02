# QVAC CLI v0.13.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.13.1

This is a patch on the 0.13 line. `qvac serve` no longer returns a successful chat or Responses completion when the client sends tools but the model was loaded without tool calling enabled.

## Bug Fixes

### Tools requests are rejected unless the model was loaded with `tools: true`

Llama.cpp only injects tool definitions when the model is loaded with `modelConfig.tools: true` (default `false`). Serve used to accept `tools` on `/v1/chat/completions` and `/v1/responses` anyway, then return `200` with prose and `finish_reason: "stop"` instead of `tool_calls`.

Those requests now return `400` with code `tools_not_enabled`. Set the flag on the served alias and reload the model:

```json
{
  "serve": {
    "models": {
      "chat": {
        "model": "QWEN3_600M_INST_Q4",
        "config": { "tools": true }
      }
    }
  }
}
```

Requests that do not send tools are unchanged. Tool calling itself is unchanged: it still works when the model was loaded with the flag.
