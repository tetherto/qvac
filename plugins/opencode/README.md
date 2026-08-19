# @qvac/opencode-plugin

Run [OpenCode](https://opencode.ai) against a **local, on-device** QVAC model
with no second terminal and no manual server. Add the plugin to a project's
`opencode.json` and `opencode` brings up a managed `qvac serve` by itself,
points OpenCode at it, and tears it down on exit.

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

The plugin registers the local `qvac` provider and selects `qvac/qwen3.5-9b`
as the project model by default.

## How it works

1. On startup the plugin spawns a **host** child process in a real node/bun
   runtime. (OpenCode runs plugins inside its own compiled binary, whose
   `process.execPath` is the editor — not a JS runtime — so managed mode can't
   spawn its detached supervisor from there. The host gives it a real runtime,
   and means the serve is reaped even if OpenCode is killed hard.)
2. The host starts a small local proxy and immediately reports it is listening —
   **before** the model downloads — handing the plugin the proxy's URL and a
   freshly generated access token over a dedicated pipe. The plugin injects an
   OpenAI-compatible `qvac` provider pointed at the proxy and returns, so
   `opencode run` never trips OpenCode's startup timeout. The model loads in the
   background; the first turn waits on it (a slow cold turn, not a failure).
3. The host runs `createQvac({ mode: 'managed' })` from
   [`@qvac/ai-sdk-provider`](https://www.npmjs.com/package/@qvac/ai-sdk-provider),
   which brings up a shared, idle-reaped serve on an auto-allocated port.

Multiple OpenCode windows **share one serve** (the provider's `reuse` default):
the detached runner owns the loaded model and reaps it a few minutes after the
last session leaves, so a second window doesn't reload the model.

## Authentication

Managed `qvac serve` requires a bearer token, and the proxy in front of it does
too — it is a loopback HTTP server, so anything else on the machine could
otherwise drive your local model.

- The host generates a random per-session **proxy token** and sends it to the
  plugin over a dedicated handshake pipe, never over its log stream. OpenCode
  authenticates with that token; a missing or wrong one gets the same
  `401 invalid_api_key` response serve returns.
- The managed serve's own key stays inside the host process. The proxy replaces
  the inbound `Authorization` header with that key, read fresh per request so a
  serve that was respawned after a crash is never sent a stale credential.
- Neither secret is written to stdout, `QVAC_HOST_LOG`, or debug traces.
- If the handshake is missing or malformed, the plugin fails startup and
  terminates the host rather than registering an unauthenticated provider.

## Model selection

You pick a friendly, models.dev-style id (`qwen3.5-9b`) and that exact id flows
through the whole stack — OpenCode's model picker (`qvac/qwen3.5-9b`) and the
request `model` field. The verbose QVAC constant
(`QWEN3_5_9B_MULTIMODAL_Q4_K_M`) stays an internal detail of the serve; the
friendly-id → constant mapping lives in `@qvac/ai-sdk-provider`'s `qvacCatalog`,
so every AI-SDK tool resolves the same ids.

The plugin accepts both friendly catalog ids and raw QVAC model constants. Use
the strongest model your machine can keep warm; coding agents are far more
sensitive to model quality than short chatbots are.

| Model value                    | Use when                                                                       | Notes                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `qwen3.5-9b`                   | You want the best friendly-id default and your machine can keep it warm.       | Default. Loads `QWEN3_5_9B_MULTIMODAL_Q4_K_M`.                                 |
| `GPT_OSS_20B_INST_Q4_K_M`      | You want a larger local text/code model for more demanding agent work.         | Raw QVAC constant; appears in OpenCode as `qvac/GPT_OSS_20B_INST_Q4_K_M`.      |
| `GEMMA4_31B_MULTIMODAL_Q4_K_M` | You want the larger Gemma4 local model and have enough memory.                 | Raw QVAC constant; appears in OpenCode as `qvac/GEMMA4_31B_MULTIMODAL_Q4_K_M`. |
| `qwen3.5-4b`                   | You need a smaller/faster model for lighter code questions or modest hardware. | Less reliable for tool-heavy workflows than 9B and larger models.              |
| `qwen3.5-2b`                   | You are smoke-testing the plugin/server path or using a low-memory machine.    | Fast, but weak for real coding-agent work.                                     |
| `qwen3.5-0.8b`                 | You need the fastest health check or demo.                                     | Not recommended for reliable tool use or code reasoning.                       |

Friendly ids are easier to read and match the model picker. Raw constants give
you access to other SDK chat models that are not yet in the friendly catalog.

## Options

Set from any of these sources (lowest to highest precedence): built-in defaults,
a `qvac.json` in the project dir, the `opencode.json` plugin-tuple options, and
`QVAC_*` environment variables.

| Option (`qvac.json` / plugin tuple) | Env                      | Default      | Meaning                                                              |
| ----------------------------------- | ------------------------ | ------------ | -------------------------------------------------------------------- |
| `model`                             | `QVAC_MODEL`             | `qwen3.5-9b` | friendly id or a raw QVAC constant                                   |
| `ctxSize`                           | `QVAC_CTX_SIZE`          | `32768`      | serve context window (an agent's prompt + tool schemas need ≥ 32768) |
| `reasoningBudget`                   | `QVAC_REASONING_BUDGET`  | `-1`         | `-1` = reasoning on, `0` = off                                       |
| `tools`                             | `QVAC_TOOLS`             | `true`       | enable the tool-calling chat template                                |
| `shim`                              | `QVAC_SHIM`              | `true`       | apply the OpenAI-compat transforms (see below)                       |
| `runtime`                           | `QVAC_RUNTIME`           | auto         | path to the node/bun runtime that hosts the serve                    |
| `readyTimeoutMs`                    | `QVAC_READY_TIMEOUT_MS`  | `1800000`    | budget for the serve to become healthy, incl. a cold model download  |
| `listenTimeoutMs`                   | `QVAC_LISTEN_TIMEOUT_MS` | `30000`      | budget for the host proxy to listen and hand over its handshake      |
| `setDefaultModel`                   | `QVAC_SET_DEFAULT_MODEL` | `true`       | force `qvac/<model>` as the project default + small model            |
| `debug`                             | `QVAC_DEBUG`             | `false`      | mirror host milestones + per-request traces to stderr                |

Via the plugin tuple in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["@qvac/opencode-plugin", { "model": "qwen3.5-2b" }]]
}
```

Or a `qvac.json` next to it:

```json
{ "model": "qwen3.5-2b", "ctxSize": 32768 }
```

## The `shim` option

`@ai-sdk/openai-compatible` (which OpenCode speaks) and QVAC serve disagree on
two points today, so the host runs a small in-process proxy that bridges them:

- **array `content`** — the AI SDK sends `content` as an array of typed parts;
  serve currently accepts only a string, so the proxy flattens text parts.
- **reasoning** — with reasoning on, the model emits `<think>…</think>` inline
  on the content channel; the proxy re-routes that to `reasoning_content` so
  OpenCode shows a collapsed "Thought" block instead of raw tags.

Both are stopgaps for serve gaps. Set `shim: false` (or `QVAC_SHIM=0`) to turn
the transforms off once serve closes those gaps; the proxy itself stays — it is
what lets startup return before the model finishes loading, and it owns the
authentication handoff described above.

## Performance expectations

With the 9B model the agent's build prompt (~26k tokens with tool schemas) is
re-prefilled each turn on a single local worker, so a tool-using turn is roughly
20–30s. A smaller model (`qwen3.5-2b`) is snappier but less capable for agentic
work. Only one QVAC worker runs machine-wide; if the OpenCode **desktop app** is
running it can hold locks the CLI needs — quit it (or isolate `XDG_*` dirs) when
running `opencode` from the terminal.

## Requirements

- [`@qvac/ai-sdk-provider@^0.6.0`](https://www.npmjs.com/package/@qvac/ai-sdk-provider)
  for managed mode (AI SDK 7). The host proxies on behalf of the managed serve,
  so it needs the provider's `ManagedQvacProvider.apiKey` getter — see
  [Provider compatibility](#provider-compatibility).
- [`@qvac/cli@^0.11.0`](https://www.npmjs.com/package/@qvac/cli) available so the
  host can run `qvac serve` (SDK 0.17 runtime). 0.11.0 is also the first CLI that
  accepts `--api-key-file`, which keeps the managed serve's bearer key out of the
  process command line.
- Node.js 22 or newer.

### Provider compatibility

The managed serve requires bearer authentication, and the proxy reads the
serve's key from the resolved `ManagedQvacProvider`. A provider release that
predates that getter cannot supply one, so the host checks for it as soon as the
managed provider is created and fails startup with an
`IncompatibleProviderError` (code `INCOMPATIBLE_PROVIDER`) naming the required
upgrade, rather than answering every proxied request with an opaque `503`. The
credential itself is never part of that error or of any log line.

The `@qvac/ai-sdk-provider` dependency floor in this package is raised as part of
the ordered agent-stack release cascade — the provider is published first, then
the plugins that depend on the new surface are bumped against the published
version. A feature branch that adds a provider surface therefore leaves the floor
alone and relies on the runtime check above; the release cascade is what turns it
into a manifest guarantee.
