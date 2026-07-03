# QVAC CLI v0.8.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.8.0

This release brings the OpenAI-compatible server up to `@qvac/sdk` 0.14.1 and adds vision input plus two reasoning-control knobs to `/v1/chat/completions`. Installing this version is how OpenCode, the AI SDK provider, and direct `qvac serve` users pick up the SDK 0.14.1 runtime.

## New APIs

### Image input in chat completions

`POST /v1/chat/completions` now accepts OpenAI-style `image_url` content parts, so vision-capable models can be driven through the same request shape OpenAI clients already use. Pass a base64 data URI or an HTTP(S) URL alongside text parts:

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

Plain string content keeps working unchanged.

### Drop reasoning from context with remove_thinking_from_context

Reasoning models can now discard a turn's thinking block from the KV cache after generation, keeping the context window focused on the visible conversation. Set the flag on the request body:

```jsonc
// POST /v1/chat/completions
{ "model": "qwen3...", "messages": [/* ... */], "remove_thinking_from_context": true }
```

### Sturdier Gemma4 completions

Gemma4 completion draining is hardened so requests that cap reasoning (for example `reasoning_budget: 0`) finish cleanly instead of stalling on the drain path:

```json
{
  "model": "gemma4-31b",
  "messages": [{ "role": "user", "content": "The ocean is" }],
  "reasoning_budget": 0
}
```

## Other Changes

The CLI's committed `@qvac/sdk` dependency now targets `^0.14.1`. Documentation gained an OpenCode plugin model-selection guide and an agent-stack test-ownership map, and the e2e suite was migrated from BATS to a `node:test` suite with added coverage for OpenAI chat-agent request shapes.
