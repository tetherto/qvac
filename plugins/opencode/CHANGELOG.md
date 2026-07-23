# Changelog

## [0.1.0]

Release Date: 2026-06-16

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.1.0

The first public release of `@qvac/opencode-plugin` — a turnkey [OpenCode](https://opencode.ai) plugin that runs a local, fully managed QVAC serve so `opencode` works against on-device models with no second terminal and no manual server.

### Added

- **Zero-config local OpenCode.** Adding `@qvac/opencode-plugin` to a project's `opencode.json` `plugin` array is enough: on startup the plugin brings up a managed `qvac serve`, injects an OpenAI-compatible `qvac` provider pointed at it, sets it as the project default model, and tears the serve down on exit. No `provider` block, no second terminal, no `QVAC_MODEL=` prefix.
- **Managed serve host process.** The plugin spawns a host child process in a real Node/Bun runtime (OpenCode runs plugins inside its own compiled binary, which cannot spawn the detached managed-mode supervisor). The host runs `createQvac({ mode: 'managed' })` from [`@qvac/ai-sdk-provider`](https://www.npmjs.com/package/@qvac/ai-sdk-provider), which brings up a shared, idle-reaped serve on an auto-allocated port, and ensures the serve is reaped even if OpenCode is killed hard.
- **Non-blocking startup.** The host starts a small local proxy and reports it is listening before the model finishes downloading, so `opencode run` never trips OpenCode's startup timeout; the model loads in the background and the first turn waits on it.
- **Shared serve across windows.** Multiple OpenCode windows share one serve (the provider's `reuse` default); the detached runner owns the loaded model and reaps it a few minutes after the last session leaves, so a second window doesn't reload the model.
- **Friendly model ids.** A models.dev-style id (e.g. `qwen3.5-9b`) flows through OpenCode's model picker and the request `model` field, with the friendly-id → QVAC constant mapping resolved via `@qvac/ai-sdk-provider`'s catalog. Defaults to `qwen3.5-9b`.
- **Layered configuration.** Options resolve from built-in defaults, a project `qvac.json`, the `opencode.json` plugin-tuple options, and `QVAC_*` environment variables (in increasing precedence): `model`, `ctxSize`, `reasoningBudget`, `tools`, `shim`, `runtime`, `readyTimeoutMs`, `setDefaultModel`, and `debug`.
- **OpenAI-compatibility shim.** An in-process proxy bridges `@ai-sdk/openai-compatible` and QVAC serve: it flattens array `content` to the string form serve currently accepts, and re-routes inline `<think>…</think>` reasoning to `reasoning_content` so OpenCode renders a collapsed "Thought" block. Disable with `shim: false` / `QVAC_SHIM=0` once serve closes those gaps; the proxy itself remains (it is what lets startup return before the model loads).
- **Examples.** Minimal and fully-annotated `opencode.json` examples for adding the plugin with and without options.
- **Explicit static tools mode.** The managed serve config pins `toolsMode: "static"` so the OpenAI-compatible client surface is unambiguous across CLI versions (the invalid `"auto"` value leaves the serve with no loaded model).

### Requirements

- [`@qvac/ai-sdk-provider@^0.2.2`](https://www.npmjs.com/package/@qvac/ai-sdk-provider) for managed mode.
- [`@qvac/cli@^0.7.0`](https://www.npmjs.com/package/@qvac/cli) so the host can run `qvac serve` (resolved by the provider's managed mode).
