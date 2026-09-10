# QVAC OpenCode Plugin v0.3.1 Release Notes

Release Date: 2026-09-07

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.3.1

This patch moves the OpenCode plugin onto `@qvac/ai-sdk-provider` 0.7 and `@qvac/cli` 0.13, so managed installs resolve a provider and CLI that agree on how a serve is launched.

## Dependency Alignment

Installs now resolve:

- `@qvac/ai-sdk-provider@^0.7.0` for managed mode, which launches `qvac serve --openai --no-default` and narrows its own optional CLI peer to `^0.13.0`
- `@qvac/cli@^0.13.0` for that serve, which mounts the serve surfaces as extensions and deprecates the `qvac serve openai` subcommand

The two floors have to move together. Provider 0.7 refuses a CLI on the 0.10–0.12 lines, so a plugin that asked for `@qvac/cli@^0.12.0` alongside it would leave the install unresolvable. Installs that pin `@qvac/cli` to `0.12.x` need to move to `0.13.x` with the plugin, since a 0.x caret range does not cross a minor.

Provider 0.7 also carries the streamed file-upload fixes released in 0.6.2, so upgrading from a 0.6.1-era install picks those up here.

Plugin behavior is unchanged: the host still starts a managed QVAC serve, injects the OpenAI-compatible `qvac` provider, and keeps the existing compatibility shim. No plugin source changed in this release — the serve launch command lives in the provider.
