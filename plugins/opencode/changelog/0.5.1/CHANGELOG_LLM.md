# QVAC OpenCode Plugin v0.5.1 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/opencode-plugin/v/0.5.1

This patch aligns the plugin's dependency ranges with `@qvac/cli` 0.21 and `@qvac/ai-sdk-provider` 0.13. Plugin behavior is unchanged.

## Dependency Alignment

Installs now resolve `@qvac/ai-sdk-provider@^0.13.0` and `@qvac/cli@^0.21.0`. A 0.x caret range does not cross a minor, so the 0.5.0 ranges would not install CLI 0.21 or provider 0.13.
