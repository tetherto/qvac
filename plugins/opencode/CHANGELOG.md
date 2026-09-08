# Changelog

## [0.3.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.0

This release pairs the plugin with the `@qvac/cli` 0.12 line. The SDK removed the dynamic tools mode, so the plugin no longer pins the field that used to select it — a behaviour-neutral change on its own, but one that ties this version to the newer host.

## Breaking Changes

### Requires the @qvac/cli 0.12 line

The plugin stops sending `toolsMode: 'static'` in the managed serve's model configuration. The SDK removed that field from its llamacpp config schema, and passing it now fails validation rather than being quietly ignored. A `0.2.x` plugin therefore cannot drive a `@qvac/cli` 0.12 / `@qvac/sdk` 0.18 serve, so the plugin and its host must move together — a normal `npm install` of this package does that.

Nothing changes about how tools are handled. `static` was the only mode this plugin ever selected, and it is now the sole behaviour: tool definitions are always prepended after the system message.

## Dependency Alignment

Installs now resolve:

- `@qvac/cli@^0.12.0` for `qvac serve` (SDK 0.18 runtime), which also brings the serve model catalog and lazy loading of models configured with `preload: false`
- `@qvac/ai-sdk-provider@^0.6.0` for managed mode, unchanged — the range already covers the 0.6.1 peer-range release

## [0.2.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.2.0

The managed serve the plugin starts is now authenticated, and the host that proxies to it has been hardened. Requests are pinned to a loopback upstream, hop-by-hop headers are no longer relayed, and a managed serve that fails to start now returns an error instead of leaving requests waiting.

## Breaking Changes

### The host handshake carries a session token, not the serve key

The private handshake between the plugin and its managed serve host now passes a per-session `proxyToken` instead of the managed serve's own API key. The host authenticates incoming proxy requests with that token and applies the real serve credential itself, so the serve key never leaves the host process.

This is internal to the plugin and its bundled host; no configuration changes. A plugin and a host from different releases cannot hand off to each other, so upgrade them together — which a normal `npm install` of this package does.

## Reliability

### A failed managed startup fails the request

If the managed provider cannot start — for example because the resolved provider is too old to expose the serve credential — proxied requests used to wait indefinitely on a readiness promise that would never settle. They now reject with a `503` naming the cause. Stopping the host while a startup is still in flight releases anything queued behind it rather than dropping the connections silently.

A host that exits after a successful handshake also now writes a line to stderr saying the `qvac` provider is gone and that OpenCode needs restarting, instead of failing quietly on the next request.

## Security

### The proxy will only talk to a loopback upstream

The host verifies that the managed serve it was handed is on a loopback address before forwarding anything to it, and refuses with an `UntrustedUpstreamError` otherwise. Hop-by-hop headers such as `proxy-connection` and `proxy-authorization` are stripped from forwarded requests, and `content-length` is always recomputed rather than copied from the incoming request.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.6.0` for managed mode, which generates and enforces the serve API key
- `@qvac/cli@^0.11.0` for `qvac serve` (SDK 0.17 runtime), the first CLI that accepts `--api-key-file` and so keeps the bearer key out of the process command line

## [0.1.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.2

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.5 and `@qvac/cli` 0.10 so managed local serves pick up the CLI 0.10 / SDK 0.17 runtime.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.5.0` for managed mode
- `@qvac/cli@^0.10.0` for `qvac serve` (SDK 0.17 runtime)

Plugin behavior is unchanged: the host still starts managed QVAC serve, injects the OpenAI-compatible `qvac` provider, and keeps the existing compatibility shim.

## [0.1.1]

Release Date: 2026-07-27

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.1

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.4 and `@qvac/cli` 0.9 so managed local serves pick up the AI SDK 7 provider and the latest CLI / SDK fixes.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.4.0` for managed mode
- `@qvac/cli@^0.9.0` for `qvac serve` (SDK 0.16 runtime)
- `@ai-sdk/openai-compatible@^3.0.0` and `ai@^7.0.0` for the AI SDK 7 peer graph

Node.js 22 or newer is required. Plugin behavior is unchanged: the host still starts managed QVAC serve, injects the OpenAI-compatible `qvac` provider, and keeps the existing compatibility shim.

## [0.1.0]

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
