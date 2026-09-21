# QVAC OpenCode Plugin v0.3.0 Release Notes

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
