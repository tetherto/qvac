# Changelog v0.1.2

Release Date: 2026-07-27

## Fixes

- Preserve OpenClaw tools during QVAC setup so enabling the local QVAC provider no longer clears the agent's existing tool configuration. (see PR [#3320](https://github.com/tetherto/qvac/pull/3320))

## Compatibility

- Depends on `@qvac/ai-sdk-provider@^0.4.0` and `@qvac/cli@^0.9.0` so installs resolve the AI SDK 7 provider and the CLI 0.9 / SDK 0.16 serve runtime.
- Requires Node.js 22 or newer (aligned with `@qvac/ai-sdk-provider` 0.4).
