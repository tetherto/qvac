# Tools at End of Prompt

## Overview

The `tools_at_end` configuration option places tool definitions at the end of the prompt (after the conversation history) instead of the default position (typically inside the system prompt). This enables KV cache optimization for multi-turn conversations with dynamic tool sets.

## Configuration

```js
const config = {
  tools: 'true',
  tools_at_end: 'true'
}
```

## Model Support

Currently `tools_at_end` is only supported for **Qwen3** models. If enabled on a non-Qwen3 model, the flag is silently ignored and a warning is logged.

## Usage Requirements

### Multi-turn Conversation Pattern

When using `tools_at_end`, consumers must follow a specific pattern:

1. **Include prior response**: Pass the assistant's previous response (including any `<tool_call>` or `<think>` blocks) back alongside the new user message.

2. **Full history each turn**: Since the KV cache is trimmed after each turn, the full conversation history must be re-provided.

```
Turn 1: [user-q-1] + [tools-1] → [response-1]
Turn 2: [response-1] + [user-q-2] + [tools-2] → [response-2]
        (tools-1 is automatically trimmed from cache)
```

3. **Strip stale tool blocks**: Remove `<tool_call>` blocks from prior responses when tools have changed to prevent model from pattern-matching on removed tools.

## Performance Characteristics

| Overhead Type | Impact | Note |
|---------------|--------|------|
| Double tokenization | ~2% | Required to calculate tool token boundary |
| Tools prefill | Up to 100% | Tools re-evaluated every turn regardless of change |

## When to Use

**Use `tools_at_end` when:**
- Long conversations with many turns (cache hit on history saves significant compute)
- Frequent tool replacement between turns (e.g., tools A → tools B → tools A)

**Use standard `tools` config when:**
- Short conversations or single-turn tool calls
- Tools remain the same across many turns

The feature provides net benefit when conversation history cache savings outweigh the tools prefill overhead.