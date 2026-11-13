# QVAC OpenClaw Plugin v0.4.3 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/openclaw-plugin/v/0.4.3

This patch moves the OpenClaw plugin onto `@qvac/cli` 0.19 and `@qvac/ai-sdk-provider` 0.12.0. Plugin behavior is unchanged.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.12.0` for the shared model catalog
- `@qvac/cli@^0.19.0` for `qvac serve --openai --no-default`

A 0.x caret range does not cross a minor, so `@qvac/cli@^0.18.0` would not install 0.19. The plugin manifest version is now 0.4.3, matching the package.

`@qvac/cli` 0.19 changes the default `qvac serve` port from 11434 to 11435. The plugin starts its own serve on a free port by default and connects to the port that serve reports, so no configuration change is needed.
