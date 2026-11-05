# Changelog v0.4.0

Release Date: 2026-10-16

## 💥 Breaking Changes

- Require the `@qvac/cli` 0.16 line and `@qvac/ai-sdk-provider` 0.10. - See [breaking changes](./breaking.md)

## 🐞 Fixes

- Start the OpenClaw serve in the plugin and verify its port. (see PR [#5025](https://github.com/tetherto/qvac/pull/5025)) - See [breaking changes](./breaking.md)
- Pin the openclaw dev dependency to 2026.8.1. (see PR [#5026](https://github.com/tetherto/qvac/pull/5026))

## Compatibility

- Depends on `@qvac/ai-sdk-provider@^0.10.0` and `@qvac/cli@^0.16.0` so installs resolve a provider and CLI that agree on the SDK 0.22 line.
