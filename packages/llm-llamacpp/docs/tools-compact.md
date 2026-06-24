# Tools Compact

## Overview

The `tools_compact` configuration option anchors tool definitions after the last input anchor message (`user` or `tool`) and automatically compacts completed tool chains from the KV cache. After a tool chain completes, the entire round-trip — tool definitions, intermediate assistant tool-call messages, and tool response messages — is trimmed, leaving only the user prompt and the final assistant answer in the cache.

## Configuration

```js
const config = {
  tools: 'true',
  tools_compact: 'true'
}
```

## Prompt Contract (Cache-Aware)

When `tools_compact` is enabled, prompt validation is cache-aware. The model rejects invalid shapes with `InvalidArgument`.

Required:

1. If the last message is `user`, `tools` must be non-empty (always required, with or without cache).
2. If the prompt ends with `tool`, `tools` are required only when no KV cache context is present.
3. If the prompt ends with `assistant` and includes the model marker (Qwen3: `<tool_call>`), `tools` are required only when no KV cache context is present.
4. If the prompt ends with `assistant` without a tool-call marker, empty `tools` are allowed.
5. When `tools` are provided, all tool definitions (`{ "type": "function", ... }`) must form a single contiguous block attached immediately after the **last** `user` or `tool` message.

This means tool definitions are not allowed:
- before any `user` or `tool` message
- after `assistant` / `tool` / other messages
- split into multiple blocks

### Valid Shape

```json
[
  { "role": "system", "content": "You are a helpful assistant." },
  { "role": "assistant", "content": "Earlier context..." },
  { "role": "user", "content": "What is weather in Tokyo?" },
  { "type": "function", "name": "getWeather", "parameters": { "type": "object" } }
]
```

### Invalid Shapes

No tools after a `user` tail:

```json
[
  { "role": "user", "content": "Hello" }
]
```

Tools without user/tool anchor:

```json
[
  { "type": "function", "name": "getWeather", "parameters": { "type": "object" } }
]
```

Detached tools (not immediately after last `user`/`tool`):

```json
[
  { "role": "user", "content": "Weather?" },
  { "role": "assistant", "content": "Let me check." },
  { "type": "function", "name": "getWeather", "parameters": { "type": "object" } }
]
```

Split tool block:

```json
[
  { "role": "user", "content": "Weather?" },
  { "type": "function", "name": "getWeather", "parameters": { "type": "object" } },
  { "role": "assistant", "content": "Need one more tool." },
  { "type": "function", "name": "lookupCity", "parameters": { "type": "object" } }
]
```

No cache + assistant tool-call tail without tools:

```json
[
  { "role": "system", "content": "You are helpful." },
  { "role": "user", "content": "Weather in Tokyo?" },
  { "role": "assistant", "content": "<tool_call>{\"name\":\"getWeather\"}</tool_call>" }
]
```

## Model Support

`tools_compact` is currently supported for:

- `qwen3` (marker: `<tool_call>`)

If enabled on any other architecture, the flag is ignored and a warning is logged.

## How It Works

### Tool Chain Lifecycle

During a tool chain, tools stay anchored in the KV cache. Trimming only happens when the chain completes (the model output contains no active family marker):

```
Round 1 (tool call):
  KV: [system] [user-q] [<tools-def>] → assistant emits <tool_call>
  → tools kept in cache, no trim

Round 2 (tool response + another call):
  KV: [system] [user-q] [<tools-def>] [assistant-tool-ask] [tool-resp] → assistant emits <tool_call>
  → tools still kept, no trim

Round 3 (final answer):
  KV: [system] [user-q] [<tools-def>] [asst-tool-ask] [tool-resp] [asst-tool-ask] [tool-resp] → assistant emits final text
  → chain complete, everything after [user-q] is trimmed
  KV: [system] [user-q]
```

### What Gets Compacted

The full multi-round tool invocation:

```
[user] → <tools-def> → [assistant-tool-ask] → [tool-resp] → [assistant-tool-ask] → [tool-resp] → [assistant-final]
```

is compacted to:

```
[user] → [assistant-final]
```

where `[assistant-final]` is passed back by the caller on the next turn and re-evaluated from the cache boundary.

### What to Pass Each Turn

The KV cache preserves earlier conversation history. Only pass:

1. **Previous assistant response** (if any) — the `assistant-final` text from the last completed turn
2. **All `tool` responses** for parallel tool calls within the current chain round
3. **New `user` prompt**

Earlier history does not need to be re-provided; it is already in the KV cache.

## Performance Characteristics

| Overhead Type | Impact | Note |
|---------------|--------|------|
| Double tokenization | ~2% | Only for the `assistant-final` message (end of chain), needed to calculate tool token boundary |
| Tools prefill | Proportional to tool definition size | Tools re-evaluated every turn; anchored across chain rounds |

## When to Use

**Use `tools_compact` when:**
- Long conversations with many turns (cache hit on history saves significant compute)
- Frequent tool replacement between turns (e.g., tools A → tools B → tools A)
- Tool responses are self-contained and not needed for reasoning in subsequent turns

**Use standard `tools` config when:**
- Short conversations or single-turn tool calls
- Tools remain the same across many turns
- The model must reason about prior tool responses in future turns (e.g., a fetched file or web page whose content is needed later)

### Important: Tool Responses Are Discarded

After compaction, all intermediate tool responses are removed from the KV cache. This means the model **cannot** reference prior tool output when answering the next user prompt. If a tool fetched external content (a file, a web page, an API response) that the model may need later, the consumer must either:

- Re-invoke the tool on the next turn so the content is fresh in context, or
- Embed the relevant data into the user message itself

The feature provides net benefit when conversation history cache savings outweigh the tools prefill overhead and tool responses are ephemeral.
