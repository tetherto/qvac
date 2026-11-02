# QVAC CLI v0.9.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/cli/v/0.9.0

This release moves the CLI to `@qvac/sdk` 0.16.0 and improves compatibility and performance for clients using the OpenAI-compatible server. It adds structured reasoning and token usage, preserves native tool-call replay for Qwen3.5 models, reuses the KV cache across chat turns, and fixes published-install coverage checks.

## Richer OpenAI-Compatible Chat Responses

Chat completions now expose model reasoning through `reasoning_content` instead of mixing thinking blocks into normal response content. Responses also report prompt, completion, total, and cached token counts from the underlying inference engine.

Streaming clients can request a final usage chunk using the OpenAI-compatible `stream_options.include_usage` option:

```json
{
  "model": "qwen3.5",
  "stream": true,
  "stream_options": { "include_usage": true },
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

The final server-sent event contains an empty `choices` array and the completed usage totals. Existing streaming requests that do not opt in continue without a usage chunk.

## More Reliable Multi-Turn Tool Calls

When a conversation replays an earlier structured tool call, the server now renders Qwen3.5 calls in the model's native tool dialect. This prevents foreign tool markup from leaking into response content and keeps follow-up tool calls parseable by coding agents and other OpenAI-compatible clients.

## Faster Repeated Chat Turns

The OpenAI-compatible chat endpoints now enable KV-cache reuse automatically. Repeated turns can reuse the cached conversation prefix, reducing prompt processing work without requiring clients to change their requests.

## File Upload Compatibility

Uploaded files now retain their original MIME type in the CLI's ephemeral file store. Content responses return the preserved type, allowing AI SDK provider file workflows to handle uploaded media correctly.

The companion `@qvac/ai-sdk-provider` release moves to AI SDK 7, provider v4, Node.js 22 or newer, and ESM-only usage. These breaking requirements apply to that provider package; `@qvac/cli` itself continues to declare Node.js 18 or newer.

## Bug Fixes

The OpenAI coverage command now resolves its router files relative to the installed package, so it no longer crashes when run from a published CLI installation. Server-side request failures also include full stack traces in logs, making production errors easier to diagnose.

## Documentation and Verification

The CLI documentation now states the Vulkan 1.4 minimum and removes an inaccurate CPU-fallback claim. A typed benchmark harness compares supported OpenAI providers and is included in the unit-test workflow to catch compatibility regressions.
