# QVAC OpenCode Plugin v0.1.0 Release Notes

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.0

The first public release of `@qvac/opencode-plugin` — a turnkey [OpenCode](https://opencode.ai) plugin that runs a local, fully managed QVAC serve so `opencode` works against on-device models with no second terminal and no manual server.

---

## Introducing `@qvac/opencode-plugin`

Add the plugin to a project's `opencode.json` and `opencode` brings up a managed `qvac serve` by itself, points OpenCode at it, and tears it down on exit:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@qvac/opencode-plugin"]
}
```

```bash
opencode          # interactive — uses qvac/qwen3.5-9b by default
opencode run "…"  # one-shot — works too (no startup race)
```

No `provider` block, no second terminal, no `QVAC_MODEL=` prefix.

## How it works

1. On startup the plugin spawns a **host** child process in a real Node/Bun runtime. OpenCode runs plugins inside its own compiled binary, whose `process.execPath` is the editor — not a JS runtime — so managed mode cannot spawn its detached supervisor from there. The host provides a real runtime and ensures the serve is reaped even if OpenCode is killed hard.
2. The host starts a small local proxy and immediately reports it is listening — **before** the model downloads. The plugin injects an OpenAI-compatible `qvac` provider pointed at the proxy and returns, so `opencode run` never trips OpenCode's startup timeout. The model loads in the background; the first turn waits on it (a slow cold turn, not a failure).
3. The host runs `createQvac({ mode: 'managed' })` from [`@qvac/ai-sdk-provider`](https://www.npmjs.com/package/@qvac/ai-sdk-provider), which brings up a shared, idle-reaped serve on an auto-allocated port.

Multiple OpenCode windows **share one serve** (the provider's `reuse` default): the detached runner owns the loaded model and reaps it a few minutes after the last session leaves, so a second window doesn't reload the model.

## Model ids

You pick a friendly, models.dev-style id (`qwen3.5-9b`) and that exact id flows through the whole stack — OpenCode's model picker (`qvac/qwen3.5-9b`) and the request `model` field. The verbose QVAC constant (`QWEN3_5_9B_MULTIMODAL_Q4_K_M`) stays an internal detail of the serve; the friendly-id → constant mapping lives in `@qvac/ai-sdk-provider`'s catalog.

| models.dev id  | QVAC constant                    |
| -------------- | -------------------------------- |
| `qwen3.5-0.8b` | `QWEN3_5_0_8B_MULTIMODAL_Q4_K_M` |
| `qwen3.5-2b`   | `QWEN3_5_2B_MULTIMODAL_Q4_K_M`   |
| `qwen3.5-4b`   | `QWEN3_5_4B_MULTIMODAL_Q4_K_M`   |
| `qwen3.5-9b`   | `QWEN3_5_9B_MULTIMODAL_Q4_K_M`   |

## Configuration

Options resolve from (lowest to highest precedence) built-in defaults, a project `qvac.json`, the `opencode.json` plugin-tuple options, and `QVAC_*` environment variables:

| Option            | Env                      | Default      | Meaning                                                       |
| ----------------- | ------------------------ | ------------ | ------------------------------------------------------------- |
| `model`           | `QVAC_MODEL`             | `qwen3.5-9b` | friendly id or a raw QVAC constant                            |
| `ctxSize`         | `QVAC_CTX_SIZE`          | `32768`      | serve context window                                          |
| `reasoningBudget` | `QVAC_REASONING_BUDGET`  | `-1`         | `-1` = reasoning on, `0` = off                                |
| `tools`           | `QVAC_TOOLS`             | `true`       | enable the tool-calling chat template                         |
| `shim`            | `QVAC_SHIM`              | `true`       | apply the OpenAI-compat transforms                            |
| `runtime`         | `QVAC_RUNTIME`           | auto         | path to the node/bun runtime that hosts the serve             |
| `readyTimeoutMs`  | `QVAC_READY_TIMEOUT_MS`  | `1800000`    | budget for the serve to become healthy, incl. a cold download |
| `setDefaultModel` | `QVAC_SET_DEFAULT_MODEL` | `true`       | force `qvac/<model>` as the project default                   |
| `debug`           | `QVAC_DEBUG`             | `false`      | mirror host milestones + per-request traces to stderr         |

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["@qvac/opencode-plugin", { "model": "qwen3.5-2b" }]]
}
```

## The `shim` option

`@ai-sdk/openai-compatible` (which OpenCode speaks) and QVAC serve disagree on two points today, so the host runs a small in-process proxy that bridges them:

- **array `content`** — the AI SDK sends `content` as an array of typed parts; serve currently accepts only a string, so the proxy flattens text parts.
- **reasoning** — with reasoning on, the model emits `<think>…</think>` inline on the content channel; the proxy re-routes that to `reasoning_content` so OpenCode shows a collapsed "Thought" block instead of raw tags.

Both are stopgaps for serve gaps. Set `shim: false` (or `QVAC_SHIM=0`) to turn the transforms off once serve closes those gaps; the proxy itself stays (it is what lets startup return before the model finishes loading).

## Requirements

- [`@qvac/ai-sdk-provider@^0.2.2`](https://www.npmjs.com/package/@qvac/ai-sdk-provider) for managed mode (its `^0.6.0 || ^0.7.0` CLI peer range is what unlocks CLI 0.7).
- [`@qvac/cli@^0.7.0`](https://www.npmjs.com/package/@qvac/cli) so the host can run `qvac serve` (resolved by the provider's managed mode).
