# 💥 Breaking Changes v0.3.0

## Requires the @qvac/cli 0.12 line

PR: [#3380](https://github.com/tetherto/qvac/pull/3380)

_No migration code — the managed serve config is private to the plugin and the host it bundles._

- The plugin no longer sends `toolsMode: 'static'` in the managed serve's model config. The SDK removed that field from its llamacpp config schema, and passing it now fails validation instead of being ignored, so plugin `0.2.x` cannot drive a `@qvac/cli` 0.12 / `@qvac/sdk` 0.18 serve. Upgrade the plugin and the host together — installing this package does that.
- Behaviour is otherwise unchanged. `static` was the only mode this plugin ever selected, and it is now the sole behaviour: tools are always prepended after the system message.
- The `@qvac/cli` dependency floor moves from `^0.11.0` to `^0.12.0` accordingly.

---
