# QVAC OpenCode Plugin v0.5.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.5.0

This release lets an OpenCode session keep its KV cache across tool calls, and moves the plugin onto `@qvac/cli` 0.20 and `@qvac/ai-sdk-provider` 0.12.1.

## Features

### Each session keeps its cache across tool calls

The plugin now marks the models it registers as supporting `prompt_cache_key`. An OpenCode version that reads that flag sends its session id with every chat request, and `qvac serve` 0.20 uses it to name the session's KV cache. Before, the cache was found by hashing the message history, which stops matching once the history ends in a tool call, so every step of an agent loop re-read the whole prompt. Now a step after a tool result only evaluates the new messages.

Nothing needs configuring. Requests without the key keep the automatic cache.

## Dependency Alignment

Installs now resolve `@qvac/ai-sdk-provider@^0.12.1` and `@qvac/cli@^0.20.0`. A 0.x caret range does not cross a minor, so `@qvac/cli@^0.19.0` would not install 0.20, which is the first CLI that accepts the key on `/v1/chat/completions`.
