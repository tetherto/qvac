# QVAC OpenClaw Plugin v0.5.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.5.0

This release lets an OpenClaw session keep its KV cache across tool calls, and moves the plugin onto `@qvac/cli` 0.20 and `@qvac/ai-sdk-provider` 0.12.1.

## Features

### Each session keeps its cache across tool calls

Every model in the plugin catalog now sets `compat.supportsPromptCacheKey`, so OpenClaw sends its session id as `prompt_cache_key` with every chat request, and `qvac serve` 0.20 uses it to name the session's KV cache. Before, the cache was found by hashing the message history, which stops matching once the history ends in a tool call, so every step of an agent loop re-read the whole prompt. With a 34k-token prompt on Qwen3.5 9B, the step after a tool result went from 106.5 s to 1.85 s.

Nothing needs configuring. Requests without the key keep the automatic cache.

## Dependency Alignment

Installs now resolve `@qvac/ai-sdk-provider@^0.12.1` and `@qvac/cli@^0.20.0`. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.19.0` would not install 0.20, which is the first CLI that accepts the key on `/v1/chat/completions`. The plugin manifest version is now 0.5.0, matching the package.
