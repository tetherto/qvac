# Agent Stack E2E Test Ownership

Use this guide when adding tests for `qvac serve openai`, `@qvac/ai-sdk-provider`, OpenCode, OpenClaw, or other agent tools that consume QVAC through an OpenAI-compatible interface.

The SDK e2e suite should stay focused on SDK consumer behavior. Agent-stack tests belong closer to the HTTP, provider, or plugin layer that owns the compatibility risk.

## Test Buckets

| Layer | Location | Owns |
| --- | --- | --- |
| SDK e2e | `packages/sdk/e2e` | Public SDK consumer/device behavior, including `loadModel()`, inference, download, lifecycle, and mobile/desktop coverage through the test-suite framework. |
| CLI TypeScript HTTP contract tests | `packages/cli/test/*.test.ts` | OpenAI-compatible request and response shapes, structured JSON assertions, SSE parsing, content-parts handling, tool-call payloads, and deterministic model-free route or adapter behavior. |
| CLI bats process e2e | `packages/cli/test/*.bats` | Built CLI startup, real `qvac serve openai` process smoke, model-load checks, network-bound endpoint smoke, logs, diagnostics, and process cleanup. |
| ai-sdk-provider integration | `packages/ai-sdk-provider/test/managed-integration.test.ts` | Vercel AI SDK calls through managed `qvac serve`, real managed serve reuse, close behavior, and opt-in real-model integration checks. |
| Plugin integration | `plugins/opencode` and future tool plugins such as `plugins/openclaw` | Tool-specific host, proxy, config, readiness, request-shaping, and shutdown behavior. |

## Decision Rules

- If the test starts with `loadModel()` and observes behavior through the public SDK API, put it in SDK e2e.
- If the test starts with an HTTP request, an OpenAI-compatible client, or an agent-tool payload, put it in CLI, provider, or plugin tests.
- Put deeply nested JSON, SSE, content-parts, and tool-call assertions in TypeScript tests when possible.
- Keep bats focused on process boundaries: the built CLI, real model startup, network reachability, logs, and cleanup.
- Plugin tests should validate host and tool integration behavior, not re-test the full SDK catalog.

## Practical Placement

Add CLI TypeScript tests under `packages/cli/test/*.test.ts` when the behavior can be exercised deterministically without loading a real model. This is the right home for content-parts arrays, chat or Responses API payload translation, JSON response shapes, and SSE chunk parsing.

Use `packages/cli/test/e2e.bats` or another bats file only when the test must prove the built `qvac` binary starts, listens on a real port, loads a model, or emits useful diagnostics during failure and cleanup.

Use `packages/ai-sdk-provider/test/managed-integration.test.ts` for opt-in real managed-serve checks. Default unit tests must remain fast and must not download models unless an integration environment explicitly enables them.

Use plugin-owned tests for OpenCode, OpenClaw, and future agent tools when the behavior depends on tool config, host readiness, proxy transforms, or lifecycle semantics around a managed QVAC serve process.
