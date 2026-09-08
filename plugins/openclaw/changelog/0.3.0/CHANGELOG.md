# Changelog v0.3.0

Release Date: 2026-09-08

## Breaking Changes

- Require the `@qvac/cli` 0.13 line and `@qvac/ai-sdk-provider` 0.7, and start the managed serve with `qvac serve --openai --no-default`. - See [breaking changes](./breaking.md)

## Fixes

- Stop generating QVAC API keys that the plugin's own validator rejects. A base64url draw beginning with `-` was refused by `normalizeApiKey`, so roughly one onboarding in 64 produced a key file the launcher would not accept.

## Compatibility

- Depends on `@qvac/ai-sdk-provider@^0.7.0` and `@qvac/cli@^0.13.0` so installs resolve a provider and CLI that agree on how a serve is launched.
