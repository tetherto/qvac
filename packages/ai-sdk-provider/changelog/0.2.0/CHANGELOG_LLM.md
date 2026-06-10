# QVAC AI SDK Provider v0.2.0 Release Notes

Release Date: 2026-06-10

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.2.0

## Managed Mode

`@qvac/ai-sdk-provider` can now run `qvac serve` for local applications instead of requiring users to start a separate server first. Calling `createQvac({ mode: 'managed', models })` creates an ephemeral serve config, starts the QVAC CLI on a free local port, waits for the OpenAI-compatible endpoint to become healthy, and returns a normal AI SDK provider pointed at that serve.

Managed serves are shared by default. If another process requests the same model fleet and config, it attaches to the existing warm serve instead of spawning another process and loading the same model into memory again. A detached runner owns the serve and reaps it after the last consumer exits and the idle timeout expires.

## Lifecycle Improvements

The managed serve lifecycle is designed for coding agents and other local tools that may start, restart, or crash frequently:

- `close()` and `await using` detach the current consumer without killing a serve that another session is still using.
- `closeOnParentExit` lets plugin hosts clean up when their parent tool exits.
- Process-group shutdown ensures the serve and its inference worker are terminated together.
- Connection-refused recovery re-resolves a serve and retries once when the backing process has disappeared before a request starts.

## Friendly Model Catalog

The package now exposes a small public catalog that maps models.dev-style ids, such as `qwen3.5-9b`, to the SDK constants that `qvac serve` loads. This keeps model ids consistent across catalog UIs, provider configuration, and generated serve configs while preserving support for raw SDK constants.

## Compatibility

External mode is unchanged and remains the default synchronous path. Managed mode is loaded only when `mode: 'managed'` is used and requires `@qvac/cli` as an optional peer dependency.
