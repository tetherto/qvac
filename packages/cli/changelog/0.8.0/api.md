# 🔌 API Changes v0.8.0

## Support image_url content in chat completions

PR: [#2459](https://github.com/tetherto/qvac/pull/2459)

```json
{
  "model": "<vlm-alias>",
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
      ]
    }
  ]
}
```

```json
{ "model": "<alias>", "messages": [{ "role": "user", "content": "hello" }] }
```

---

## Expose remove_thinking_from_context completion param

PR: [#2797](https://github.com/tetherto/qvac/pull/2797)

```typescript
// SDK — drop this turn's reasoning block from the KV cache after generation
await model.completion({
  history,
  generationParams: { remove_thinking_from_context: true }
})
```

```jsonc
// CLI serve OpenAI API — same flag on the request body
// POST /v1/chat/completions { "model": "qwen3...", "messages": [...], "remove_thinking_from_context": true }
```

---

## Harden Gemma4 completion drains

PR: [#2802](https://github.com/tetherto/qvac/pull/2802)

```json
{
  "model": "gemma4-31b",
  "messages": [{ "role": "user", "content": "The ocean is" }],
  "reasoning_budget": 0
}
```

---
